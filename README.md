# HW01 - My Own ChatGPT with Gemini

A simple ChatGPT-style web app for the assignment. It uses the Gemini API and supports model selection, custom system prompt, API parameters, streaming replies, and short-term memory.

## Features

1. Choose a Gemini model
2. Customize the system prompt
3. Customize common API parameters
4. Stream responses token by token
5. Keep short-term conversation memory
6. Protect the API key with `.env`

## Tech Stack

- Frontend: HTML / CSS / Vanilla JavaScript
- Backend: Node.js built-in `http` server
- API: Gemini API REST `streamGenerateContent`

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

4. Open the browser

```text
http://localhost:3000
```

## Security Notes

- Do not upload `.env` to GitHub
- Keep the API key on the server side only
- `.gitignore` already excludes `.env`

## Project Structure

```text
.
|-- public/
|   |-- app.js
|   |-- index.html
|   `-- styles.css
|-- .env.example
|-- .gitignore
|-- package.json
|-- README.md
`-- server.js
```

## Demo Suggestion

For the 3-minute demo:

1. Open the page and show model switching
2. Change the system prompt
3. Change temperature, top_p, and max tokens
4. Send a prompt and show streaming
5. Ask a follow-up question to show memory
6. Show the GitHub repo and confirm `.env` is not uploaded

## GitHub

```bash
git init
git add .
git commit -m "feat: build my own gemini chat app hw01"
```

## Gemini Docs Used

- Text generation: https://ai.google.dev/gemini-api/docs/text-generation
- Generate content REST API: https://ai.google.dev/api/generate-content
- Models REST API: https://ai.google.dev/api/models
