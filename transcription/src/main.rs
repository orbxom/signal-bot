use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, Write};

const PROTOCOL_VERSION: &str = "2025-03-26";

#[derive(Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

fn tool_definition() -> Value {
    serde_json::json!({
        "name": "transcribe_audio",
        "description": "Transcribe a voice message audio file to text using Whisper",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Absolute path to the audio file"
                }
            },
            "required": ["file_path"]
        }
    })
}

fn main() {
    env_logger::init();

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: JsonRpcRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": format!("Parse error: {}", e) }
                });
                let _ = writeln!(stdout, "{}", err_resp);
                let _ = stdout.flush();
                continue;
            }
        };

        let response = handle_request(&req);
        if let Some(resp) = response {
            let json = serde_json::to_string(&resp).unwrap();
            let _ = writeln!(stdout, "{}", json);
            let _ = stdout.flush();
        }
    }
}

fn handle_request(req: &JsonRpcRequest) -> Option<JsonRpcResponse> {
    let id = req.id.clone().unwrap_or(Value::Null);

    match req.method.as_str() {
        "initialize" => Some(JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "signal-bot-transcription", "version": "1.0.0" }
            })),
            error: None,
        }),
        "notifications/initialized" => None,
        "tools/list" => Some(JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(serde_json::json!({ "tools": [tool_definition()] })),
            error: None,
        }),
        "tools/call" => {
            let result = handle_tool_call(req.params.as_ref());
            Some(JsonRpcResponse {
                jsonrpc: "2.0",
                id,
                result: Some(result),
                error: None,
            })
        }
        _ => {
            if req.id.is_some() {
                Some(JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: None,
                    error: Some(serde_json::json!({
                        "code": -32601,
                        "message": format!("Method not found: {}", req.method)
                    })),
                })
            } else {
                None
            }
        }
    }
}

fn handle_tool_call(params: Option<&Value>) -> Value {
    let tool_name = params
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("");

    match tool_name {
        "transcribe_audio" => {
            let file_path = params
                .and_then(|p| p.get("arguments"))
                .and_then(|a| a.get("file_path"))
                .and_then(|f| f.as_str())
                .unwrap_or("");

            if file_path.is_empty() {
                return serde_json::json!({
                    "content": [{ "type": "text", "text": "Missing file_path argument" }],
                    "isError": true
                });
            }

            match transcribe_file(file_path) {
                Ok(text) => serde_json::json!({
                    "content": [{ "type": "text", "text": text }]
                }),
                Err(e) => serde_json::json!({
                    "content": [{ "type": "text", "text": format!("Transcription error: {}", e) }],
                    "isError": true
                }),
            }
        }
        _ => serde_json::json!({
            "content": [{ "type": "text", "text": format!("Unknown tool: {}", tool_name) }],
            "isError": true
        }),
    }
}

fn transcribe_file(_file_path: &str) -> Result<String, String> {
    Err("Transcription not yet implemented".to_string())
}
