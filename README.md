# Margin

**A tutor in your margin.** Write through a math problem on a whiteboard and receive feedback while you work. Margin looks for the first mistaken step, offers a short guiding question, and checks the corrected work without giving away the answer by default.

This is a local hackathon prototype built with **FastAPI, plain HTML/CSS/JavaScript, and SymPy**. The whiteboard runs in the browser; handwriting recognition and tutoring use a connected AI provider. Internet access is required for AI feedback.

## The experience

- Draw with a stylus, finger, or mouse, or use **Type a step** for keyboard input.
- Pause for two seconds to trigger a board check. **Check now** is also available.
- See the first questionable line highlighted beside a Socratic hint. Ask for a stronger hint when needed.
- Erase or undo a mistake, rewrite it, and receive fresh feedback on the current board.
- Ask questions in the adjacent chat, which receives the problem and current board.
- Refresh without losing the current board and conversation, when browser storage is available.

There is no application account system or database. Provider sign-in connects the tutor. Mistake memory, personalized practice, voice tutoring, and a class dashboard are future directions, not implemented features.

## Run locally

Requirements: **Python 3.11+**, a modern browser, and internet access for the tutor. Node.js is optional and only needed for the board tests. There is no frontend build step.

From the repository directory, create a virtual environment:

```sh
python -m venv .venv
```

Activate it on Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1
```

Or on macOS/Linux:

```sh
source .venv/bin/activate
```

Install and start:

```sh
python -m pip install -r requirements.txt
python run.py
```

Open **[http://127.0.0.1:8000](http://127.0.0.1:8000)** on the computer running the server. Keep the terminal open. `run.py` prints local network addresses for a tablet and loads `.python-packages` when that optional local dependency folder exists.

On Windows, `./start.ps1` is a convenience launcher. It prefers the project's virtual environment, then an available bundled Codex Python runtime, then ordinary Python. Dependencies must already be installed.

The equivalent direct server command, after installing dependencies in the active environment, is:

```sh
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --no-access-log
```

Keep port **8000** for ChatGPT sign-in: its callback is configured as `http://127.0.0.1:8000/auth/callback`. The launcher disables access logs so temporary sign-in codes do not appear in routine URL logs.

## Connect ChatGPT first

1. Open Margin on the host computer at `http://127.0.0.1:8000`.
2. Choose **Connect your tutor**, then **Continue with ChatGPT**.
3. Complete the provider's sign-in and consent flow, allowing ChatGPT plan usage if offered.
4. Return to Margin and check the connection. Write a short step to confirm a real tutor response before presenting.

The app implements OpenAI's dynamic OAuth flow for locally hosted apps: a saved host identifier, PKCE, state and nonce checks, ID-token validation, token refresh, model discovery, and streamed Responses requests. Plan access depends on the account and granted permissions; a connected identity alone is not a guarantee that inference will succeed. See the official [ChatGPT plan usage documentation](https://developers.openai.com/siwc/token-sharing-open-source).

This route requests permission to use the ChatGPT plan. It does not treat a token count displayed elsewhere as an ordinary API credit balance, and it does not request access to existing ChatGPT conversations.

Connection credentials stay on the server in `.local/chatgpt-auth.json`, which is excluded from Git. They are not sent to the browser. The app applies local folder/file permissions to that storage.

### Optional Gemini fallback

If ChatGPT plan usage is unavailable, Gemini is the implemented API-key fallback. Create a `.env` file from `.env.example` if one does not already exist, then configure:

```dotenv
LLM_API_KEY=your_gemini_api_key
LLM_MODEL=gemini-flash-latest
```

Use a Gemini model available to your key; `LLM_MODEL` can be changed accordingly. See Google's [Gemini API-key guide](https://ai.google.dev/gemini-api/docs/api-key). The `.env` file is ignored by Git and read by the server. Never put a key in a board step or tutor chat.

ChatGPT takes priority while an account is connected. **A failed ChatGPT request is not silently retried using a paid API key.** Configured Gemini credentials are used when there is no active ChatGPT connection. API usage is subject to that provider's quota and billing.

## Use a tablet

Start the server and finish ChatGPT sign-in on the laptop first. On a tablet connected to the same Wi-Fi, open one of the `Same Wi-Fi` addresses printed by `python run.py`, such as `http://192.168.1.25:8000`.

The server listens on `0.0.0.0:8000` so other devices on the local network can reach it. Use a trusted network: these devices share the host server's active tutor connection. The board itself is saved separately in each browser; the app does not synchronize strokes between devices.

If the tablet cannot connect, check that both devices are on the same network and that the host firewall permits the server on the private network. ChatGPT sign-in and connection management must be performed on the host computer, because OAuth returns to its loopback address.

## How a check works

1. **Capture:** the browser groups strokes into rows and assigns stable IDs and normalized bounding boxes. It sends the current board image, problem, row positions, and any typed text after a two-second pause.
2. **Read and coach:** the provider transcribes handwritten rows and returns structured judgments, separate legibility and math-confidence scores, and short hints.
3. **Verify:** SymPy checks supported algebraic transitions against the original problem and preceding line. A handwritten transcription must have confidence of at least **0.8** before it enters symbolic verification. Exact typed input bypasses handwriting recognition.
4. **Combine:** a definitive symbolic result takes priority. Unsupported math falls back to contextual AI judgment, with the same **0.8** minimum for confident feedback. Unclear work is marked uncertain. After the earliest error or uncertainty, dependent rows wait for clarification.
5. **Display:** the frontend uses its own row boxes to position highlights. It runs one board check at a time and ignores responses for an older board revision, preventing erased mistakes from reappearing through delayed feedback.

The verifier compares real solution sets for supported single-variable equations, so a valid alternate path such as `2(x - 3) = 10` → `x - 3 = 5` is accepted. It also checks rational domain restrictions, basic simplification, and selected derivatives. Input goes through a bounded arithmetic grammar, not Python evaluation.

**Verification is deliberately limited.** Inequalities, geometry, many domain-sensitive expressions, multivariable work, and unsupported notation return `unknown` from SymPy. AI can review broader math in context, but the app is not a general proof checker and its feedback can be wrong. Legibility confidence is model-reported, not a guarantee of transcription accuracy.

## Project map

| File | Role |
| --- | --- |
| `static/index.html`, `static/styles.css` | Whiteboard and tutor interface |
| `static/board.js` | Drawing, erasing, history, row grouping, image export |
| `static/app.js` | Pause detection, requests, revision checks, chat, browser persistence |
| `main.py` | FastAPI routes, request validation, confidence gates, feedback combination |
| `llm.py` | Provider requests, handwriting reader, coach, tutor chat |
| `auth.py` | ChatGPT OAuth and local credential storage |
| `verifier.py` | Conservative SymPy verification |
| `run.py`, `start.ps1` | Local launchers |
| `tests/` | Math, backend, and board regression checks |

`GET /api/status` reports the configured connection and SymPy availability. `POST /api/analyze` checks a board; `POST /api/chat` answers with board context. The server does not save board images to disk. The browser stores the current problem, strokes, and recent conversation locally; AI requests send the current problem and board to the active provider.

## Tests and demonstration

With Python dependencies installed:

```sh
python -m unittest discover -s tests -p "test_*.py" -v
```

For the optional browser-independent board checks, use a modern Node.js release:

```sh
node --test tests/board.test.mjs
```

These tests cover symbolic mistakes and corrections, valid alternate paths, confidence handling, and row grouping. Passing them does not establish that a particular provider account can complete live inference. Verify that separately before the demo.

See **[docs/DEMO.md](docs/DEMO.md)** for the rehearsal sequence and exact sample problem.
