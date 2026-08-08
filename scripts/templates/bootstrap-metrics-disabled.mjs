const sendJson = (response, statusCode, body) => {
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
};

export default function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, { error: "method-not-allowed" });
    return;
  }
  sendJson(response, 503, { error: "metrics-temporarily-unavailable" });
}
