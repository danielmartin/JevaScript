"""Loopback-only HTTP adapter for Vela. Load once, reuse for every request."""
import argparse
import json
import logging
import os
import hmac
import contextlib
import sys
import math
from http.server import BaseHTTPRequestHandler, HTTPServer


def validate(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("state"), (str, dict, list)):
        raise ValueError("state must be text, an object, or an array")
    questions = payload.get("questions")
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 64:
        raise ValueError("Expected 1 to 64 questions")
    for key, question in questions.items():
        if not isinstance(key, str) or not key.strip() or not isinstance(question, dict):
            raise ValueError("Invalid question")
        if not isinstance(question.get("instructions"), str) or not question["instructions"].strip():
            raise ValueError("instructions must be a nonempty string")
        kind = question.get("type")
        if kind not in ("noul", "choice", "score"):
            raise ValueError("Invalid question type")
        if kind == "noul":
            if "criteria" in question:
                raise ValueError("Boolean questions do not accept criteria")
            continue
        criteria = question.get("criteria")
        allowed = (list,) if kind == "score" else (list, dict)
        if not isinstance(criteria, allowed) or not 2 <= len(criteria) <= 32:
            raise ValueError("criteria must contain 2 to 32 options")
        if any(not isinstance(c, str) or not c.strip() for c in criteria):
            raise ValueError("Each criterion must be a nonempty string")
        if len(set(criteria)) != len(criteria):
            raise ValueError("criteria must be distinct")
        if isinstance(criteria, dict) and any(not isinstance(v, str) or not v.strip() for v in criteria.values()):
            raise ValueError("Criterion descriptions must be nonempty strings")
    return payload["state"], questions


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("JSON numbers must be finite")
    return number


def reject_constant(value):
    raise ValueError("Invalid JSON number: " + value)


def make_server(agent, port=8765):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def reply(self, status, payload):
            data = json.dumps(payload, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            token = os.environ.get("JEVA_WORKER_TOKEN")
            if token and not hmac.compare_digest(self.headers.get("x-jeva-token", ""), token):
                return self.reply(403, {"error": "Invalid worker token"})
            # Reject browser origins and rebinding hosts; this adapter is local only.
            hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            if self.headers.get("Host") not in hosts or self.headers.get("Origin") is not None:
                return self.reply(403, {"error": "Only local non-browser clients are allowed"})
            if self.path != "/predict":
                return self.reply(404, {"error": "Unknown endpoint"})
            if self.headers.get_content_type() != "application/json":
                return self.reply(415, {"error": "Expected application/json"})
            try:
                if self.headers.get("Transfer-Encoding"):
                    raise ValueError("Transfer encoding is not supported")
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1_048_576:
                    return self.reply(413, {"error": "Expected a body of at most 1 MiB"})
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError("Incomplete request")
                payload = json.loads(data, parse_float=finite_float, parse_constant=reject_constant)
                state, questions = validate(payload)
            except (ValueError, RecursionError):
                return self.reply(400, {"error": "Invalid request state or questions"})
            try:
                result = agent.predict(state, questions)
                # Validate serialization before writing HTTP headers.
                json.dumps(result, allow_nan=False)
            except Exception:
                logging.exception("Vela inference failed")
                return self.reply(500, {"error": "Vela inference failed"})
            try:
                self.reply(200, result)
            except (BrokenPipeError, ConnectionResetError):
                pass  # A caller can cancel while the model finishes its forward pass.

        def log_message(self, format, *args):
            pass  # Do not log request contents.

    # ponytail: serial inference for one local client; use a serving engine for concurrent throughput.
    return HTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default="dmartincy/vela")
    parser.add_argument("--device", choices=["cpu", "mps", "cuda"])
    args = parser.parse_args()
    import vela

    with contextlib.redirect_stdout(sys.stderr):
        agent = vela.load(args.model, device=args.device)
    with make_server(agent, args.port) as server:
        print("JEVA_READY " + json.dumps({"port": server.server_port}), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
