const RESPONSE_BODY = '{"error":"api-not-found"}';

export default function handler(_request, response) {
  response.statusCode = 404;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(RESPONSE_BODY);
}
