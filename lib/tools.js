const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "get_current_weather",
        description: "Get the current weather for a location",
        parameters: {
          type: "OBJECT",
          properties: {
            location: { type: "STRING", description: "City name, e.g. Taipei" }
          },
          required: ["location"]
        }
      },
      {
        name: "calculate",
        description: "Evaluate a mathematical expression",
        parameters: {
          type: "OBJECT",
          properties: {
            expression: { type: "STRING", description: "Math expression, e.g. 2+2*3" }
          },
          required: ["expression"]
        }
      },
      {
        name: "web_search",
        description: "Search the web for current information",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Search query" }
          },
          required: ["query"]
        }
      }
    ]
  }
];

const WEATHER_CODES = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snow fall",
  73: "moderate snow fall",
  75: "heavy snow fall",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail"
};

module.exports = {
  TOOLS,
  getToolNames,
  executeTool
};

function getToolNames() {
  return TOOLS.flatMap((tool) => tool.functionDeclarations.map((fn) => fn.name));
}

async function executeTool(name, args, signal) {
  if (name === "calculate") {
    return executeCalculation(args?.expression);
  }

  if (name === "get_current_weather") {
    return getCurrentWeather(args?.location, signal);
  }

  if (name === "web_search") {
    return webSearch(args?.query, signal);
  }

  throw new Error(`Unsupported tool: ${name}`);
}

function executeCalculation(expression) {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error("A math expression is required.");
  }

  const source = expression.trim();
  if (!/^[0-9+\-*/().,%\s^A-Za-z]+$/.test(source)) {
    throw new Error("Expression contains unsupported characters.");
  }

  const allowedMath = source
    .replace(/Math\.(abs|ceil|floor|round|min|max|pow|sqrt|sin|cos|tan|log|exp|PI|E)/g, "")
    .replace(/\d+(\.\d+)?/g, "")
    .replace(/[+\-*/().,%\s^]/g, "");

  if (allowedMath) {
    throw new Error("Only Math.* helpers and basic operators are allowed.");
  }

  const jsExpression = source.replace(/\^/g, "**");
  const result = Function(`"use strict"; return (${jsExpression})`)();

  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("Expression did not produce a finite number.");
  }

  return String(result);
}

async function getCurrentWeather(location, signal) {
  if (typeof location !== "string" || !location.trim()) {
    throw new Error("A location is required.");
  }

  const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location.trim())}&count=1`;
  const geocodePayload = await fetchJson(geocodeUrl, signal);
  const place = Array.isArray(geocodePayload?.results) ? geocodePayload.results[0] : null;

  if (!place) {
    return `No weather data found for ${location.trim()}.`;
  }

  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(place.latitude)}&longitude=${encodeURIComponent(place.longitude)}&current_weather=true`;
  const weatherPayload = await fetchJson(weatherUrl, signal);
  const current = weatherPayload?.current_weather;

  if (!current) {
    return `No weather data found for ${location.trim()}.`;
  }

  const description = WEATHER_CODES[current.weathercode] || "unknown conditions";
  return `Current weather in ${place.name}: ${current.temperature}°C, wind ${current.windspeed} km/h, code ${current.weathercode} (${description})`;
}

async function webSearch(query, signal) {
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("A search query is required.");
  }

  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query.trim())}&format=json&no_html=1&skip_disambig=1`;
  const payload = await fetchJson(url, signal);
  const resultText = extractDuckDuckGoText(payload);

  return resultText || "No results found.";
}

function extractDuckDuckGoText(payload) {
  if (typeof payload?.AbstractText === "string" && payload.AbstractText.trim()) {
    return payload.AbstractText.trim();
  }

  if (typeof payload?.Answer === "string" && payload.Answer.trim()) {
    return payload.Answer.trim();
  }

  const topics = Array.isArray(payload?.RelatedTopics) ? payload.RelatedTopics : [];
  for (const topic of topics) {
    if (typeof topic?.Text === "string" && topic.Text.trim()) {
      return topic.Text.trim();
    }

    if (Array.isArray(topic?.Topics)) {
      for (const nestedTopic of topic.Topics) {
        if (typeof nestedTopic?.Text === "string" && nestedTopic.Text.trim()) {
          return nestedTopic.Text.trim();
        }
      }
    }
  }

  return "";
}

async function fetchJson(url, signal) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    signal
  });

  if (!response.ok) {
    throw new Error(`External request failed with status ${response.status}.`);
  }

  return response.json();
}
