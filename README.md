# HW02 - My Own ChatGPT v2

A zero-dependency ChatGPT-style web app built with Node.js built-in modules and vanilla JavaScript. It now supports persistent memory, multimodal image input, automatic model routing, function calling tools, multi-chat session management, export, editing/regeneration, and voice input.

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
- API: Gemini REST API (`generateContent` / `streamGenerateContent`)

No extra npm packages are required.

## Run

1. Create `.env`

```bash
copy .env.example .env
```

2. Add your Gemini API key

```env
GEMINI_API_KEY=your_real_key
PORT=3000
```

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

- Gemini availability and API key status
- Available model list
- Persistent memory entry count
- Registered tool names

## Notes

- The backend remains zero-dependency.
- `server.js` only starts the server when run directly; `node -e "require('./server.js')"` now succeeds without hanging.
- Pro / blocked Gemini models are filtered out to avoid quota failures.

## Docs

- System intro and architecture diagram: [docs/system-architecture.md](docs/system-architecture.md)
