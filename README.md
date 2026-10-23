# NOVA AI

![Tests](https://github.com/Mdafnan18/nova-ai/actions/workflows/tests.yml/badge.svg)

An animated AI avatar you can talk to. NOVA listens to your voice, thinks with a local AI model running on your own computer, and answers out loud, all with free and open-source tools.

## Live demo

https://your-real-address.onrender.com

The public website runs in **demo mode** with a few built-in replies, because a free host cannot reach an AI model running on my laptop. The first visit after a quiet period can take about a minute to wake up. For full AI answers, run the project locally (instructions below).

## Screenshots

![NOVA idle with a conversation](docs/screenshots/01-idle.png)
![NOVA listening to voice input](docs/screenshots/02-listening.png)
![NOVA speaking](docs/screenshots/03-speaking.png)
![NOVA on a phone-sized screen](docs/screenshots/04-mobile.png)

## Features

- Animated avatar with five states: idle, listening, thinking, speaking and error
- Glowing orbital rings, floating particles, blinking eyes and eyes that follow the mouse
- Chat with real AI answers from a local model (Ollama), with a short conversation memory
- Ask questions about a short .txt or .md file (local AI mode only)
- Streaming answers that appear word by word as the AI writes them
- Voice input with the microphone, with permission handling and a typed fallback
- Spoken replies with a voice on/off button
- Speaks the answer sentence by sentence while it is still being written
- Enter to send, Shift+Enter for a new line, clear chat and suggested prompts
- Health check that tells you if the backend or the AI model is not ready
- Demo mode for public hosting when no AI model is available
- Responsive layout, keyboard-friendly buttons and reduced-motion support

## Tech stack

- Python and Flask (backend and JSON API)
- HTML5, CSS3 and vanilla JavaScript (frontend)
- Ollama with the qwen2.5:3b model (local AI)
- SQLite (conversation storage)
- Web Speech API (browser voice input and spoken replies)
- gunicorn and Render (free hosting)
- Git and GitHub

## How it works

```text
Browser (HTML, CSS, JavaScript)
   |  fetch() sends your message
   v
Flask backend (Python)
   |  checks the message, keeps the history
   v
Ollama (local AI model on your computer)
   |  writes the answer
   v
Flask -> Browser: the answer appears, the avatar animates, the browser speaks it
```

The browser never talks to Ollama directly. Flask sits in the middle so every message is checked first.

## Run it locally on Windows 11

You need Python 3.11 or newer, Git, and [Ollama](https://ollama.com/download).

```powershell
git clone https://github.com/Mdafnan18/nova-ai.git
cd nova-ai
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
ollama pull qwen2.5:3b
Copy-Item .env.example .env
```

Open `.env`, set `AI_MODE=ollama`, and put a long random text as `SECRET_KEY`. You can make one with:

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
```

Start the app and open http://127.0.0.1:5000 in Chrome or Edge:

```powershell
python app.py
```

If PowerShell refuses to activate the virtual environment, run this once and try again:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

## Configuration

All settings live in a `.env` file (never uploaded to GitHub). See `.env.example`.

| Setting | Meaning |
|---|---|
| `AI_MODE` | `demo` (built-in replies) or `ollama` (real local AI) |
| `OLLAMA_URL` | Address of Ollama, default `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Model name, default `qwen2.5:3b` |
| `OLLAMA_TIMEOUT_SECONDS` | How long to wait for the AI before giving up |
| `OLLAMA_MAX_TOKENS` | Maximum length of an answer |
| `OLLAMA_NUM_CTX` | How much text the AI can read at once, default 4096 |
| `DOC_MAX_CHARS` | Longest document accepted for questions, default 6000 characters |
| `MAX_MESSAGE_CHARS` | Longest message accepted |
| `MAX_HISTORY_MESSAGES` | How many messages NOVA remembers |
| `DATABASE_PATH` | Where conversations are stored (a SQLite file), default `nova.db` |
| `HISTORY_DAYS` | How many days conversations are kept, default 7 |
| `RATE_LIMIT_PER_MINUTE` | Chat requests allowed per minute per visitor |
| `SECRET_KEY` | Secret used to sign the session cookie |
| `FLASK_DEBUG` | `1` on a laptop only, always `0` on a public site |
| `TRUST_PROXY` | `1` when running behind a host's proxy, such as Render |
| `SESSION_COOKIE_SECURE` | `1` when the site is served over https |

## API

| Endpoint | What it does |
|---|---|
| `GET /api/health` | Reports the mode, whether the AI is ready and the message limit |
| `POST /api/chat` | Send `{"message": "Hello"}` and receive `{"reply": "..."}` |
| `POST /api/clear` | Clears the conversation memory |
| `GET /api/document` | Tells the page if a document is loaded |
| `POST /api/document` | Send `{"name": "notes.txt", "text": "..."}` to load a document (local AI mode only) |
| `POST /api/document/clear` | Removes the loaded document |

## Tests

The backend has automatic tests. They use pretend AI replies, so they run without Ollama. Run them with:

```powershell
python -m unittest tests.test_api -v
```

They also run on every push with GitHub Actions.

## Security

- Messages are validated: they must be text, not empty, and within the size limit
- Requests over 16 KB are refused
- Simple rate limit per visitor
- Request timeout when talking to the AI, with friendly error messages
- Internal errors are logged on the server and never shown to visitors
- Debug mode is off in production
- No API keys or secrets in the frontend code, and `.env` is ignored by Git
- Security headers and a strict Content-Security-Policy in production
- Ollama only listens on the local computer and is never exposed to the internet
- Conversations are stored on the server for up to 7 days, and Clear chat deletes them
- Uploaded documents are stored the same way, can be removed at any time, and are turned off in demo mode

## Deploy for free on Render

1. Push the project to GitHub.
2. On Render, create a Web Service from the repository (Python 3, Free instance).
3. Build command: `pip install -r requirements.txt`
4. Start command: `gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --threads 4 --timeout 60`
5. Environment variables: `AI_MODE=demo`, `FLASK_DEBUG=0`, `TRUST_PROXY=1`, `SESSION_COOKIE_SECURE=1` and a new random `SECRET_KEY`.

## Limitations

- The public site uses demo mode. Real AI answers need Ollama running on your own computer.
- Free Render services sleep after 15 minutes without visitors, so the first load can be slow.
- Conversations are stored in a small SQLite file on the server and kept for up to 7 days. On free hosting the file is erased when the service restarts or redeploys.
- Voice input works in Chrome and Edge and needs internet, because the browser sends the audio to its own speech service.
- Tested with Chrome on Windows 11.

## Roadmap

- 3D avatar with Three.js
- Avatar customization (colors and voice picker)
- Saved conversations
- Question answering over uploaded documents
- A separately hosted AI backend for the public site

## What I learned

- Keeping the AI service behind my own backend, so the browser never talks to it directly and every message is checked first
- Handling failures with friendly messages, such as Ollama being closed, a missing model or a slow answer
- Streaming an answer to the browser line by line and speaking it sentence by sentence
- Working with browser permissions for the microphone, and giving a typed fallback
- Deploying with environment variables and keeping secrets out of Git
- Writing automatic tests that use pretend AI replies

## Project structure

```text
nova-ai/
|-- app.py                 Flask backend and API
|-- requirements.txt       Python packages
|-- .env.example           Sample settings (safe to share)
|-- .python-version        Python version for the host
|-- static/
|   |-- css/               style.css, effects.css, voice.css
|   `-- js/                app.js, effects.js, voice.js
|-- templates/
|   `-- index.html         The page
|-- tests/                 Automatic tests
|-- .github/workflows/     Test automation (GitHub Actions)
|-- LICENSE                MIT License
`-- docs/screenshots/      Pictures used in this README
```

## License

The code is released under the MIT License (see the LICENSE file). The AI model is downloaded separately through Ollama and has its own license, so check it before using the project commercially.
