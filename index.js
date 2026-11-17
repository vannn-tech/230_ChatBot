const express = require("express");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENROUTER_MODEL || "inclusionai/ling-3.2-flash:free";

app.use(express.json());
app.use(express.static("public"));

app.get("/", (req, res) => {
    res.redirect("/index.html");
});

app.post("/api/chat", async (req, res) => {
    try {
        if (!process.env.OPENROUTER_API_KEY) {
            return res.status(503).json({
                error: "OPENROUTER_API_KEY belum diatur di file .env"
            });
        }

        const messages = req.body.messages;
        
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                 error: "Messages harus berupa array"
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

        while (true) {
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
                const trimmedLine = line.trim();

                if (!trimmedLine) {
                    continue;
                }

                if (!trimmedLine.startsWith("data:")) {
                    continue;
                }

                const data = trimmedLine.slice(5).trim();

                if (data === "[DONE]") {
                    continue;
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
            }
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

app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});