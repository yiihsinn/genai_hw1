# HW02 - My Own ChatGPT v2

A zero-dependency ChatGPT-style web app built with Node.js built-in modules and vanilla JavaScript. The app now runs on NVIDIA NIM using its OpenAI-compatible Chat Completions API and includes persistent memory, multimodal image input, auto-routing, tool use, chat export, edit/regenerate, multi-session storage, and voice input.

## Features

1. Persistent memory stored in `memory.json`
2. Automatic long-chat summarization into reusable memory bullets
3. Multimodal image upload with drag-and-drop and preview
4. Automatic vision model override for image requests
5. Auto Route model selection based on prompt complexity
6. Function calling tools for weather, calculator, and web search
7. Export chat as JSON or Markdown
8. Edit user messages and regenerate downstream replies
9. Multi-session local chat management with `chat_<timestamp>` keys
10. Voice input with Web Speech API fallback handling

## Tech Stack

- Frontend: HTML / CSS / Vanilla JavaScript modules
- Backend: Node.js built-in `http`, `fs`, `path`, `url`
- Provider: NVIDIA NIM `https://integrate.api.nvidia.com/v1`
- API format: OpenAI-compatible Chat Completions with SSE streaming

No extra npm packages are required.

## Run

1. Create `.env`

```bash
copy .env.example .env
```

2. Add your NVIDIA NIM API key

```env
NIM_API_KEY=nvapi-your_real_key
PORT=3000
```

The server also accepts `NVIDIA_API_KEY` as a fallback env var.

3. Start the app

```bash
npm start
```

4. Open:

```text
http://localhost:3000
```

## Project Structure

```text
.
|-- lib/
|   |-- gemini.js
|   |-- memory.js
|   |-- router.js
|   |-- sse.js
|   `-- tools.js
|-- public/
|   |-- modules/
|   |   |-- api.js
|   |   |-- memory-ui.js
|   |   |-- state.js
|   |   |-- tools-ui.js
|   |   `-- ui.js
|   |-- app.js
|   |-- index.html
|   `-- styles.css
|-- docs/
|   `-- system-architecture.md
|-- memory.json
|-- .env.example
|-- package.json
|-- README.md
`-- server.js
```

## Health Endpoint

`GET /api/health` returns:

- NVIDIA NIM availability and API key status
- Available model list
- Persistent memory entry count
- Registered tool names

## Notes

- The backend remains zero-dependency.
- `server.js` only starts the server when run directly; `node -e "require('./server.js')"` succeeds without hanging.
- Image requests are sent as OpenAI-style `content` arrays with `text` and `image_url` items.
- Tool use uses OpenAI-compatible `tools` and `tool_calls`.

## Docs

- System intro and architecture diagram: [docs/system-architecture.md](docs/system-architecture.md)
