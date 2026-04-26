function startSseResponse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
}

function writeSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamTextChunks(res, text) {
  const chunkSize = 80;

  for (let index = 0; index < text.length; index += chunkSize) {
    writeSse(res, "token", {
      delta: text.slice(index, index + chunkSize)
    });
  }
}

module.exports = {
  startSseResponse,
  writeSse,
  streamTextChunks
};
