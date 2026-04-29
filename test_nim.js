const http = require("http");

async function testQuery(prompt) {
  const payload = JSON.stringify({
    model: "meta/llama-3.3-70b-instruct", // initial
    autoRoute: true,
    messages: [
      { role: "user", content: prompt }
    ]
  });

  return new Promise((resolve) => {
    let rawRouting = "";
    
    const req = http.request(
      "http://localhost:3000/api/chat",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        res.on("data", (chunk) => {
          const str = chunk.toString();
          if (str.includes("event: routing") || str.includes("event: model_override")) {
            rawRouting += str;
          }
        });
        res.on("end", () => resolve(rawRouting));
      }
    );
    req.write(payload);
    req.end();
  });
}

(async () => {
  const r1 = await testQuery('請幫我把 "Hello, testing the new feature" 翻譯成繁體中文。');
  console.log("Scenario 1 Routing:\n", r1);
  
  const r2 = await testQuery('你好');
  console.log("Scenario 2 Routing:\n", r2);
  
  const r3 = await testQuery('請解釋這段程式碼的功能：\n```javascript\nconsole.log(1+1);\n```');
  console.log("Scenario 3 Routing:\n", r3);
})();
