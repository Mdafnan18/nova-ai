"""Automatic tests for the NOVA AI backend.

Run them from the project folder with:
    python -m unittest tests.test_api -v
"""
import json
import os
import tempfile
import unittest
from unittest import mock

# These settings are set BEFORE app.py is imported, so the tests never depend on your .env file.
os.environ["AI_MODE"] = "demo"
os.environ["FLASK_DEBUG"] = "0"
os.environ["SECRET_KEY"] = "test-secret-key-used-only-by-the-tests"
os.environ["RATE_LIMIT_PER_MINUTE"] = "1000"
os.environ["MAX_MESSAGE_CHARS"] = "1000"
os.environ["MAX_HISTORY_MESSAGES"] = "20"
os.environ["DATABASE_PATH"] = os.path.join(tempfile.mkdtemp(), "nova-test.db")

import app as nova  # noqa: E402


def read_events(response):
    """Turns a streamed answer (one JSON object per line) into a list of dictionaries."""
    text = response.get_data(as_text=True)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = nova.app.test_client()
        nova.hits.clear()
        nova.clear_all_history()

    def chat(self, message):
        return self.client.post("/api/chat", json={"message": message})

    def test_home_page_loads(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"NOVA", response.data)

    def test_health_check(self):
        response = self.client.get("/api/health")
        data = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["mode"], "demo")
        self.assertTrue(data["ai_ready"])

    def test_chat_returns_a_reply(self):
        response = self.chat("Hello")
        data = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(data["reply"], str)
        self.assertTrue(data["reply"])

    def test_empty_message_is_rejected(self):
        response = self.chat("    ")
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.get_json())

    def test_message_with_only_hidden_characters_is_rejected(self):
        response = self.chat("\x00\x01\x02")
        self.assertEqual(response.status_code, 400)

    def test_missing_message_is_rejected(self):
        response = self.client.post("/api/chat", json={})
        self.assertEqual(response.status_code, 400)

    def test_message_must_be_text(self):
        response = self.client.post("/api/chat", json={"message": 123})
        self.assertEqual(response.status_code, 400)

    def test_message_at_the_limit_is_accepted(self):
        response = self.chat("a" * 1000)
        self.assertEqual(response.status_code, 200)

    def test_message_over_the_limit_is_rejected(self):
        response = self.chat("a" * 1001)
        self.assertEqual(response.status_code, 400)
        self.assertIn("too long", response.get_json()["error"])

    def test_non_json_request_is_rejected(self):
        response = self.client.post("/api/chat", data="hello", content_type="text/plain")
        self.assertEqual(response.status_code, 415)

    def test_broken_json_is_rejected(self):
        response = self.client.post("/api/chat", data="{bad json", content_type="application/json")
        self.assertEqual(response.status_code, 400)

    def test_json_list_instead_of_object_is_rejected(self):
        response = self.client.post("/api/chat", json=[1, 2, 3])
        self.assertEqual(response.status_code, 400)

    def test_huge_request_is_rejected(self):
        body = b'{"message":"' + b"a" * 100000 + b'"}'
        response = self.client.post("/api/chat", data=body, content_type="application/json")
        self.assertEqual(response.status_code, 413)

    def test_unknown_api_address_gives_json_error(self):
        response = self.client.get("/api/does-not-exist")
        self.assertEqual(response.status_code, 404)
        self.assertIn("error", response.get_json())

    def test_wrong_method_gives_json_error(self):
        response = self.client.get("/api/chat")
        self.assertEqual(response.status_code, 405)
        self.assertIn("error", response.get_json())

    def test_security_headers_are_present(self):
        response = self.client.get("/")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
        self.assertIn("Content-Security-Policy", response.headers)

    def test_history_returns_the_conversation(self):
        self.chat("Hello")
        data = self.client.get("/api/history").get_json()
        roles = [item["role"] for item in data["messages"]]
        self.assertEqual(roles, ["user", "assistant"])

    def test_clear_endpoint_empties_the_history(self):
        self.chat("Hello")
        response = self.client.post("/api/clear")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "cleared")
        data = self.client.get("/api/history").get_json()
        self.assertEqual(data["messages"], [])

    def test_history_is_limited(self):
        with mock.patch.object(nova, "MAX_HISTORY_MESSAGES", 6):
            last = None
            for _ in range(5):
                last = self.chat("Hello").get_json()
        self.assertEqual(last["history_size"], 6)

    def test_rate_limit_blocks_too_many_requests(self):
        with mock.patch.object(nova, "RATE_LIMIT_PER_MINUTE", 3):
            codes = [self.chat("Hello").status_code for _ in range(4)]
        self.assertEqual(codes, [200, 200, 200, 429])


class StreamTests(unittest.TestCase):
    """Tests for the answer that arrives piece by piece."""

    def setUp(self):
        self.client = nova.app.test_client()
        nova.hits.clear()
        nova.clear_all_history()

    def test_demo_stream_sends_tokens_then_done(self):
        response = self.client.post("/api/chat/stream", json={"message": "Hello"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/x-ndjson")

        events = read_events(response)
        self.assertEqual(events[0]["type"], "token")
        self.assertEqual(events[-1]["type"], "done")

        joined = "".join(event["text"] for event in events if event["type"] == "token")
        self.assertEqual(joined.strip(), events[-1]["reply"])

    def test_stream_rejects_an_empty_message(self):
        response = self.client.post("/api/chat/stream", json={"message": "   "})
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.get_json())

    def test_ollama_stream_sends_pieces_and_saves_history(self):
        fake = mock.Mock(status_code=200)
        fake.iter_lines.return_value = iter([
            b'{"message": {"content": "Hi "}, "done": false}',
            b'{"message": {"content": "there."}, "done": false}',
            b'{"done": true}',
        ])
        with mock.patch.object(nova, "AI_MODE", "ollama"), mock.patch.object(
            nova.requests, "post", return_value=fake
        ):
            response = self.client.post("/api/chat/stream", json={"message": "Hello"})
            events = read_events(response)

        self.assertEqual([event["type"] for event in events], ["token", "token", "done"])
        self.assertEqual(events[-1]["reply"], "Hi there.")

        history = self.client.get("/api/history").get_json()["messages"]
        self.assertEqual(len(history), 2)

    def test_stream_gives_a_normal_error_when_ollama_is_closed(self):
        with mock.patch.object(nova, "AI_MODE", "ollama"), mock.patch.object(
            nova.requests, "post", side_effect=nova.requests.exceptions.ConnectionError()
        ):
            response = self.client.post("/api/chat/stream", json={"message": "Hello"})
        self.assertEqual(response.status_code, 503)
        self.assertIn("Ollama", response.get_json()["error"])

    def test_connection_lost_halfway_sends_an_error_and_saves_nothing(self):
        def broken_lines():
            yield b'{"message": {"content": "Hi "}, "done": false}'
            raise nova.requests.exceptions.ConnectionError()

        fake = mock.Mock(status_code=200)
        fake.iter_lines.return_value = broken_lines()
        with mock.patch.object(nova, "AI_MODE", "ollama"), mock.patch.object(
            nova.requests, "post", return_value=fake
        ):
            response = self.client.post("/api/chat/stream", json={"message": "Hello"})
            events = read_events(response)

        self.assertEqual(events[0]["type"], "token")
        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(nova.count_sessions(), 0)  # a half answer is never saved


class OllamaTests(unittest.TestCase):
    """These tests pretend to be Ollama, so they work even if Ollama is closed."""

    def setUp(self):
        self.client = nova.app.test_client()
        nova.hits.clear()
        nova.clear_all_history()

    def test_ollama_reply_is_returned(self):
        fake = mock.Mock(status_code=200)
        fake.json.return_value = {"message": {"content": "Hi from the model."}}
        with mock.patch.object(nova, "AI_MODE", "ollama"), mock.patch.object(
            nova.requests, "post", return_value=fake
        ):
            response = self.client.post("/api/chat", json={"message": "Hello"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["reply"], "Hi from the model.")

    def test_ollama_not_running_gives_friendly_error(self):
        with mock.patch.object(nova, "AI_MODE", "ollama"), mock.patch.object(
            nova.requests, "post", side_effect=nova.requests.exceptions.ConnectionError()
        ):
            response = self.client.post("/api/chat", json={"message": "Hello"})
        self.assertEqual(response.status_code, 503)
        self.assertIn("Ollama", response.get_json()["error"])
        self.assertEqual(nova.count_sessions(), 0)  # a failed answer is not saved

    def test_ollama_timeout_gives_friendly_error(self):
        with mock.patch.object(nova, "AI_MODE", "ollama"), mock.patch.object(
            nova.requests, "post", side_effect=nova.requests.exceptions.Timeout()
        ):
            response = self.client.post("/api/chat", json={"message": "Hello"})
        self.assertEqual(response.status_code, 504)
        self.assertIn("too long", response.get_json()["error"])

    def test_missing_model_tells_you_how_to_install_it(self):
        fake = mock.Mock(status_code=404, text="model not found")
        with mock.patch.object(nova, "AI_MODE", "ollama"), mock.patch.object(
            nova.requests, "post", return_value=fake
        ):
            response = self.client.post("/api/chat", json={"message": "Hello"})
        self.assertEqual(response.status_code, 503)
        self.assertIn("ollama pull", response.get_json()["error"])

    def test_health_check_reports_ollama_down(self):
        with mock.patch.object(nova, "AI_MODE", "ollama"), mock.patch.object(
            nova.requests, "get", side_effect=nova.requests.exceptions.ConnectionError()
        ):
            response = self.client.get("/api/health")
        data = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertFalse(data["ai_ready"])


class DocumentTests(unittest.TestCase):
    """Tests for asking questions about an uploaded text file."""

    def setUp(self):
        self.client = nova.app.test_client()
        nova.hits.clear()
        nova.clear_all_history()

    def upload(self, name="notes.txt", text="NOVA was built with Flask and Ollama."):
        with mock.patch.object(nova, "AI_MODE", "ollama"):
            return self.client.post("/api/document", json={"name": name, "text": text})

    def test_document_is_saved_and_listed(self):
        response = self.upload()
        self.assertEqual(response.status_code, 200)
        data = self.client.get("/api/document").get_json()
        self.assertEqual(data["document"]["name"], "notes.txt")

    def test_folders_are_removed_from_the_file_name(self):
        self.upload(name="C:\\Users\\me\\notes.txt")
        data = self.client.get("/api/document").get_json()
        self.assertEqual(data["document"]["name"], "notes.txt")

    def test_documents_are_not_allowed_in_demo_mode(self):
        response = self.client.post("/api/document", json={"name": "notes.txt", "text": "Hello"})
        self.assertEqual(response.status_code, 403)

    def test_empty_document_is_rejected(self):
        response = self.upload(text="    ")
        self.assertEqual(response.status_code, 400)

    def test_document_that_is_too_long_is_rejected(self):
        response = self.upload(text="a" * (nova.DOC_MAX_CHARS + 1))
        self.assertEqual(response.status_code, 400)
        self.assertIn("limit", response.get_json()["error"])

    def test_other_file_types_are_rejected(self):
        response = self.upload(name="photo.png")
        self.assertEqual(response.status_code, 400)

    def test_document_text_is_sent_to_the_ai(self):
        self.upload(text="The secret code word is PINEAPPLE.")
        fake = mock.Mock(status_code=200)
        fake.json.return_value = {"message": {"content": "It is PINEAPPLE."}}
        with mock.patch.object(nova, "AI_MODE", "ollama"), mock.patch.object(
            nova.requests, "post", return_value=fake
        ) as post:
            response = self.client.post("/api/chat", json={"message": "What is the code word?"})
        self.assertEqual(response.status_code, 200)
        payload = post.call_args.kwargs["json"]
        self.assertIn("PINEAPPLE", payload["messages"][0]["content"])

    def test_clear_chat_also_removes_the_document(self):
        self.upload()
        self.client.post("/api/clear")
        data = self.client.get("/api/document").get_json()
        self.assertIsNone(data["document"])

    def test_remove_document_endpoint(self):
        self.upload()
        response = self.client.post("/api/document/clear")
        self.assertEqual(response.status_code, 200)
        data = self.client.get("/api/document").get_json()
        self.assertIsNone(data["document"])


if __name__ == "__main__":
    unittest.main()
