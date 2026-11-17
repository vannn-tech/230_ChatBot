const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENROUTER_MODEL || "inclusionai/ling-3.2-flash:free";
const MAX_MESSAGES = 21;
const MAX_MESSAGE_LENGTH = 4000;

app.use(express.json({ limit: "128kb" }));
app.use(express.static("public"));

app.get("/", (req, res) => {
    res.redirect("/index.html");
});

app.post("/api/chat", async (req, res) => {
    try {
        const messages = req.body && req.body.messages;

        if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
            return res.status(400).json({
                error: `Messages harus berupa array berisi 1 sampai ${MAX_MESSAGES} pesan`
            });
        }

        const validRoles = new Set(["system", "user", "assistant"]);
        const invalidMessage = messages.some((message) =>
            !message ||
            !validRoles.has(message.role) ||
            typeof message.content !== "string" ||
            message.content.length === 0 ||
            message.content.length > MAX_MESSAGE_LENGTH
        );
        if (invalidMessage) {
            return res.status(400).json({
                error: `Setiap pesan harus punya role yang valid dan isi 1 sampai ${MAX_MESSAGE_LENGTH} karakter`
            });
        }

        if (!process.env.OPENROUTER_API_KEY) {
            return res.status(503).json({
                error: "OPENROUTER_API_KEY belum diatur di file .env"
            });
        }

        const response = await fetch(
            "https://openrouter.ai/api/v1/chat/completions",
             {
                method: "POST",

                headers: {
                    "Content-Type": "application/json",                    "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                },

                body: JSON.stringify({
                    model: MODEL,
                    messages: messages,
                    temperature: 0.7,
                    max_tokens: 1000,
                    stream: true
                })
            }
        );

        if (!response.ok) {
            const errorData = await response.text();
            console.error("OpenRouter Error:", errorData);
            return res.status(response.status).json({ error: errorData });
        }

        // Header untuk streaming
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let buffer = "";
        let finished = false;

        const sendLine = (line) => {
            const trimmedLine = line.trim();
            if (!trimmedLine.startsWith("data:")) {
                return;
            }

            const data = trimmedLine.slice(5).trim();
            if (data === "[DONE]") {
                finished = true;
                return;
            }

            try {
                const parsed = JSON.parse(data);
                const content = parsed.choices[0].delta.content;
                if (content) {
                    res.write(`data: ${JSON.stringify({ content })}\n\n`);
                }
            } catch (error) {
                console.error("JSON Parse Error:", error);
            }
        };

        while (!finished) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            buffer += decoder.decode(value, {
                stream: true
            });

            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                sendLine(line);
                if (finished) break;
            }
        }

        buffer += decoder.decode();
        if (finished) {
            await reader.cancel();
        }
        if (buffer) {
            sendLine(buffer);
        }
        res.end();

    } catch (error) {
        console.error("Server Error:", error);

        if (!res.headersSent) {
            res.status(500).json({
                error: "Terjadi kesalahan pada server"
            });
        } else {
            res.end();
        }
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server berjalan di http://localhost:${PORT}`);
    });
}

module.exports = app;