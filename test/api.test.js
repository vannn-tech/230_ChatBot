const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const app = require("../index");

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function postChat(messages) {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

test("nolakin request kalau daftar pesan nggak dikirim", async () => {
  const response = await postChat(undefined);
  assert.equal(response.status, 400);
});

test("nolakin pesan dengan role yang nggak dikenal", async () => {
  const response = await postChat([{ role: "admin", content: "hai" }]);
  assert.equal(response.status, 400);
});

test("nolakin pesan yang kepanjangan", async () => {
  const response = await postChat([{ role: "user", content: "a".repeat(4001) }]);
  assert.equal(response.status, 400);
});
