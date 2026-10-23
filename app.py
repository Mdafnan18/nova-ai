import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from collections import deque
from contextlib import closing
from datetime import timedelta

import requests
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, session
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("nova")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# ---------- Settings (read from the .env file or the environment) ----------

def env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def env_int(name, default, minimum, maximum):
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default
    return max(minimum, min(value, maximum))


DEBUG = env_bool("FLASK_DEBUG", False)
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = env_int("PORT", 5000, 1, 65535)
MAX_MESSAGE_CHARS = env_int("MAX_MESSAGE_CHARS", 1000, 1, 4000)
MAX_HISTORY_MESSAGES = env_int("MAX_HISTORY_MESSAGES", 20, 2, 100)
HISTORY_DAYS = env_int("HISTORY_DAYS", 7, 1, 90)
RATE_LIMIT_PER_MINUTE = env_int("RATE_LIMIT_PER_MINUTE", 30, 1, 600)
MAX_SESSIONS = 500
MAX_REPLY_CHARS = 2000

_database_setting = os.environ.get("DATABASE_PATH", "nova.db").strip() or "nova.db"
DATABASE_PATH = (
    _database_setting if os.path.isabs(_database_setting) else os.path.join(BASE_DIR, _database_setting)
)

AI_MODE = os.environ.get("AI_MODE", "demo").strip().lower()
if AI_MODE not in ("demo", "ollama"):
    log.warning("AI_MODE '%s' is not known. Using demo mode.", AI_MODE)
    AI_MODE = "demo"

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").strip().rstrip("/")
if not OLLAMA_URL.startswith(("http://", "https://")):
    log.warning("OLLAMA_URL must start with http:// or https://. Using the default.")
    OLLAMA_URL = "http://127.0.0.1:11434"

OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:3b").strip() or "qwen2.5:3b"
OLLAMA_TIMEOUT_SECONDS = env_int("OLLAMA_TIMEOUT_SECONDS", 120, 5, 600)
OLLAMA_MAX_TOKENS = env_int("OLLAMA_MAX_TOKENS", 300, 20, 2000)

SYSTEM_PROMPT = (
    "You are NOVA, a friendly futuristic AI avatar assistant. "
    "Answer in simple, clear English. "
    "Keep answers short, usually two to four sentences, because your answer will be spoken aloud. "
    "Do not use markdown, bullet lists, or emojis. "
    "If you do not know something, say so honestly."
)

app = Flask(__name__)

if env_bool("TRUST_PROXY", False):
    # On Render a proxy sits in front of the app. This lets Flask see the real visitor IP and https.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

secret_key = os.environ.get("SECRET_KEY")
if not secret_key:
    secret_key = secrets.token_hex(32)
    log.warning(
        "SECRET_KEY is not set. Using a temporary one; saved conversations cannot be found again after a restart."
    )

app.secret_key = secret_key
app.config.update(
    MAX_CONTENT_LENGTH=16 * 1024,  # refuse requests bigger than 16 KB
    PERMANENT_SESSION_LIFETIME=timedelta(days=HISTORY_DAYS),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=env_bool("SESSION_COOKIE_SECURE", False),
)


# ---------- Conversation history (saved in a SQLite database file) ----------

def connect_db():
    connection = sqlite3.connect(DATABASE_PATH, timeout=5)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    # "with closing(...) as connection, connection" closes the file at the end and saves the changes.
    with closing(connect_db()) as connection, connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS messages ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "session_id TEXT NOT NULL, "
            "role TEXT NOT NULL, "
            "content TEXT NOT NULL, "
            "created_at REAL NOT NULL)"
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, id)")


init_db()


def get_session_id():
    sid = session.get("sid")
    if not isinstance(sid, str) or len(sid) != 32:
        sid = secrets.token_hex(16)
        session["sid"] = sid
    session.permanent = True  # keep the cookie for several days, not just until the browser closes
    return sid


def get_history(sid):
    with closing(connect_db()) as connection:
        rows = connection.execute(
            "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (sid, MAX_HISTORY_MESSAGES),
        ).fetchall()
    return [{"role": row["role"], "content": row["content"]} for row in reversed(rows)]


def add_turn(sid, user_text, reply):
    """Saves one question and its answer, then tidies up old data."""
    now = time.time()
    with closing(connect_db()) as connection, connection:
        connection.executemany(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            [(sid, "user", user_text, now), (sid, "assistant", reply, now)],
        )
        # Keep only the newest messages of this conversation.
        connection.execute(
            "DELETE FROM messages WHERE session_id = ? AND id NOT IN "
            "(SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?)",
            (sid, sid, MAX_HISTORY_MESSAGES),
        )
        # Forget messages older than HISTORY_DAYS.
        connection.execute("DELETE FROM messages WHERE created_at < ?", (now - HISTORY_DAYS * 86400,))
        # Keep only the newest MAX_SESSIONS conversations.
        connection.execute(
            "DELETE FROM messages WHERE session_id IN ("
            "SELECT session_id FROM messages GROUP BY session_id ORDER BY MAX(id) DESC LIMIT -1 OFFSET ?)",
            (MAX_SESSIONS,),
        )


def history_count(sid):
    with closing(connect_db()) as connection:
        row = connection.execute("SELECT COUNT(*) AS total FROM messages WHERE session_id = ?", (sid,)).fetchone()
    return row["total"]


def clear_history(sid):
    with closing(connect_db()) as connection, connection:
        connection.execute("DELETE FROM messages WHERE session_id = ?", (sid,))


def clear_all_history():
    # Used by the automatic tests to start from an empty database.
    with closing(connect_db()) as connection, connection:
        connection.execute("DELETE FROM messages")


def count_sessions():
    with closing(connect_db()) as connection:
        row = connection.execute("SELECT COUNT(DISTINCT session_id) AS total FROM messages").fetchone()
    return row["total"]


# ---------- Simple rate limit (per IP address) ----------

hits = {}
hits_lock = threading.Lock()


def rate_limited(key):
    now = time.monotonic()
    with hits_lock:
        window = hits.setdefault(key, deque())
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= RATE_LIMIT_PER_MINUTE:
            return True
        window.append(now)
        if len(hits) > 2000:
            old_keys = [k for k, v in hits.items() if not v or now - v[-1] > 60]
            for k in old_keys:
                del hits[k]
    return False


# ---------- Helpers ----------

def api_error(message, status):
    response = jsonify({"error": message})
    response.status_code = status
    return response


def clean_text(value):
    # Remove hidden control characters but keep new lines and tabs.
    return "".join(ch for ch in value if ch in "\n\t" or ch.isprintable()).strip()


def ndjson(event):
    # One JSON object per line. The browser reads the answer line by line while it streams in.
    return json.dumps(event, ensure_ascii=False) + "\n"


class AIError(Exception):
    """A problem with the AI that we can explain to the user in plain words."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.message = message
        self.status = status


# ---------- Demo replies (used when AI_MODE=demo) ----------

def demo_reply(text):
    lower = text.lower()
    words = set(re.findall(r"[a-z']+", lower))

    if words & {"hi", "hello", "hey"}:
        return "Hello! Nice to meet you. I'm NOVA, your futuristic AI companion."
    if "who are you" in lower or "your name" in lower:
        return "I'm NOVA, an animated AI avatar built with Flask, JavaScript and CSS."
    if "what can you do" in lower:
        return ("In demo mode I only know a few answers. With a local AI model I can answer "
                "almost any question, and I can listen to your voice and speak back.")
    if "space" in words:
        return "Fun fact: a day on Venus is longer than a year on Venus."
    if "explain ai" in lower or "artificial intelligence" in lower:
        return ("AI is software that learns patterns from lots of examples, "
                "so it can answer questions or recognise things without being told every rule.")

    preview = text if len(text) <= 80 else text[:80] + "..."
    return 'You said: "' + preview + '". I am in demo mode, so I only know a few answers.'


def demo_stream(text):
    # Sends the demo reply word by word, so the public demo also shows the typing effect.
    for word in demo_reply(text).split(" "):
        yield word + " "
        time.sleep(0.03)


# ---------- Ollama (real local AI) ----------

def ollama_status():
    """Returns (is_ready, message). Used by the health check."""
    try:
        response = requests.get(OLLAMA_URL + "/api/tags", timeout=2)
        response.raise_for_status()
        names = [item.get("name", "") for item in response.json().get("models", [])]
    except (requests.exceptions.RequestException, ValueError, AttributeError):
        return False, "Ollama is not running. Open the Ollama app, then reload this page."

    wanted = OLLAMA_MODEL if ":" in OLLAMA_MODEL else OLLAMA_MODEL + ":latest"
    if wanted not in names:
        return False, "The model %s is not installed. Run: ollama pull %s" % (OLLAMA_MODEL, OLLAMA_MODEL)

    return True, "Local AI ready. Model: %s" % OLLAMA_MODEL


def build_ollama_payload(history, user_message, stream):
    messages = [{"role": "system", "content": SYSTEM_PROMPT}] + history + [
        {"role": "user", "content": user_message}
    ]
    return {
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": stream,
        "keep_alive": "10m",  # keep the model in memory for 10 minutes so later answers are faster
        "options": {"num_predict": OLLAMA_MAX_TOKENS},
    }


def ollama_post(payload, stream):
    """Sends the request to Ollama and turns every problem into a friendly AIError."""
    try:
        response = requests.post(
            OLLAMA_URL + "/api/chat",
            json=payload,
            stream=stream,
            timeout=(5, OLLAMA_TIMEOUT_SECONDS),
        )
    except requests.exceptions.ConnectionError:
        raise AIError("I cannot reach Ollama. Open the Ollama app and try again.", 503)
    except requests.exceptions.Timeout:
        raise AIError("The AI took too long to answer. Try a shorter question or a smaller model.", 504)
    except requests.exceptions.RequestException:
        log.exception("Ollama request failed")
        raise AIError("Something went wrong while talking to Ollama.", 502)

    if response.status_code == 404:
        response.close()
        raise AIError(
            "The model %s is not installed. Run: ollama pull %s" % (OLLAMA_MODEL, OLLAMA_MODEL), 503
        )
    if response.status_code != 200:
        log.error("Ollama returned status %s: %s", response.status_code, response.text[:300])
        response.close()
        raise AIError("Ollama returned an error. Check the server terminal for details.", 502)

    return response


def ask_ollama(history, user_message):
    """Waits for the whole answer. Used by /api/chat."""
    response = ollama_post(build_ollama_payload(history, user_message, False), False)

    try:
        reply = response.json()["message"]["content"]
    except (ValueError, KeyError, TypeError):
        raise AIError("Ollama sent an answer I could not read.", 502)
    finally:
        response.close()

    reply = clean_text(reply) if isinstance(reply, str) else ""
    if not reply:
        raise AIError("The AI sent an empty answer. Please try again.", 502)

    return reply[:MAX_REPLY_CHARS]


def ollama_stream(history, user_message):
    """Yields the answer in small pieces while Ollama writes it. Used by /api/chat/stream."""
    response = ollama_post(build_ollama_payload(history, user_message, True), True)
    deadline = time.monotonic() + OLLAMA_TIMEOUT_SECONDS

    try:
        for line in response.iter_lines():
            if time.monotonic() > deadline:
                raise AIError("The AI took too long to answer. Try a shorter question or a smaller model.", 504)
            if not line:
                continue

            try:
                data = json.loads(line)
            except ValueError:
                raise AIError("Ollama sent an answer I could not read.", 502)
            if not isinstance(data, dict):
                raise AIError("Ollama sent an answer I could not read.", 502)

            if data.get("error"):
                log.error("Ollama stream error: %s", data["error"])
                raise AIError("Ollama stopped with an error. Check the server terminal for details.", 502)

            message = data.get("message")
            piece = message.get("content") if isinstance(message, dict) else None
            if isinstance(piece, str) and piece:
                yield piece

            if data.get("done"):
                break
    except requests.exceptions.Timeout:
        raise AIError("The AI took too long to answer. Try a shorter question or a smaller model.", 504)
    except requests.exceptions.RequestException:
        log.exception("The connection to Ollama was lost while streaming")
        raise AIError("The connection to Ollama was lost.", 502)
    finally:
        response.close()


# ---------- Checking a chat request ----------

def read_chat_message():
    """Checks the request. Returns (session_id, message, error_response)."""
    sid = get_session_id()

    if rate_limited(request.remote_addr or sid):
        return sid, None, api_error("You are sending messages too fast. Please wait a moment.", 429)

    if not request.is_json:
        return sid, None, api_error("Please send JSON.", 415)

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return sid, None, api_error("The request body must be a JSON object.", 400)

    message = data.get("message")
    if not isinstance(message, str):
        return sid, None, api_error("The message must be text.", 400)

    message = clean_text(message)
    if not message:
        return sid, None, api_error("Please type a message first.", 400)
    if len(message) > MAX_MESSAGE_CHARS:
        return sid, None, api_error(
            "Your message is too long. The limit is %d characters." % MAX_MESSAGE_CHARS, 400
        )

    return sid, message, None


# ---------- Routes ----------

@app.get("/")
def home():
    return render_template("index.html")


@app.get("/api/health")
def health():
    if AI_MODE == "ollama":
        ready, message = ollama_status()
    else:
        ready = True
        message = "Demo mode: NOVA answers with a few built-in replies. Run the project locally with Ollama for full AI answers."

    return jsonify({
        "status": "ok",
        "mode": AI_MODE,
        "ai_ready": ready,
        "message": message,
        "max_message_chars": MAX_MESSAGE_CHARS,
    })


@app.post("/api/chat")
def chat():
    sid, message, error = read_chat_message()
    if error is not None:
        return error

    if AI_MODE == "ollama":
        try:
            reply = ask_ollama(get_history(sid), message)
        except AIError as problem:
            return api_error(problem.message, problem.status)
    else:
        reply = demo_reply(message)

    # Only save the conversation turn when everything worked.
    add_turn(sid, message, reply)

    return jsonify({"reply": reply, "mode": AI_MODE, "history_size": history_count(sid)})


@app.post("/api/chat/stream")
def chat_stream():
    sid, message, error = read_chat_message()
    if error is not None:
        return error

    if AI_MODE == "ollama":
        pieces_iter = ollama_stream(get_history(sid), message)
    else:
        pieces_iter = demo_stream(message)

    # Wait for the first piece. If the AI is not available, we can still answer with a proper error code.
    try:
        first = next(pieces_iter)
    except StopIteration:
        return api_error("The AI sent an empty answer. Please try again.", 502)
    except AIError as problem:
        return api_error(problem.message, problem.status)

    def generate():
        pieces = [first]
        failed = None

        try:
            yield ndjson({"type": "token", "text": first})
            size = len(first)
            for piece in pieces_iter:
                pieces.append(piece)
                size += len(piece)
                yield ndjson({"type": "token", "text": piece})
                if size >= MAX_REPLY_CHARS:
                    break
        except AIError as problem:
            failed = problem.message
        except Exception:
            log.exception("Unexpected error while streaming an answer")
            failed = "Something went wrong on the server. Please try again."
        finally:
            pieces_iter.close()

        if failed:
            yield ndjson({"type": "error", "error": failed})
            return

        reply = clean_text("".join(pieces))[:MAX_REPLY_CHARS]
        if not reply:
            yield ndjson({"type": "error", "error": "The AI sent an empty answer. Please try again."})
            return

        # Only save the conversation turn when the whole answer arrived.
        add_turn(sid, message, reply)
        yield ndjson({"type": "done", "reply": reply, "mode": AI_MODE, "history_size": history_count(sid)})

    return Response(generate(), mimetype="application/x-ndjson", headers={"X-Accel-Buffering": "no"})


@app.get("/api/history")
def chat_history():
    return jsonify({"messages": get_history(get_session_id())})


@app.post("/api/clear")
def clear():
    clear_history(get_session_id())
    return jsonify({"status": "cleared"})


# ---------- Safety: headers and errors ----------

@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "microphone=(self), camera=(), geolocation=()"

    if not app.debug:
        # In production only our own files may load. (Skipped in debug so Flask's error page works.)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
            "connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
        )

    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"

    return response


@app.errorhandler(HTTPException)
def handle_http_error(error):
    if request.path.startswith("/api/"):
        messages = {
            400: "Bad request.",
            404: "That address does not exist.",
            405: "That method is not allowed here.",
            413: "The request is too large.",
            415: "Please send JSON.",
        }
        return api_error(messages.get(error.code, error.name), error.code)
    return error


@app.errorhandler(Exception)
def handle_unexpected_error(error):
    log.error("Unexpected error", exc_info=error)
    if app.debug:
        raise error  # on your laptop, show the full Flask error page
    if request.path.startswith("/api/"):
        return api_error("Something went wrong on the server. Please try again.", 500)
    return "Something went wrong on the server.", 500


if __name__ == "__main__":
    # FLASK_DEBUG comes from your .env file. Never turn it on for a public website.
    app.run(host=HOST, port=PORT, debug=DEBUG)