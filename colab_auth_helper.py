#!/usr/bin/env python3
import sys
import json
import os
import subprocess
from importlib import resources

TOKEN_DIR = os.path.expanduser("~/.config/colab-cli")
TOKEN_PATH = os.path.join(TOKEN_DIR, "token.json")
FLOW_STATE_PATH = os.path.join(TOKEN_DIR, "auth_flow_state.json")

def get_client_config():
    custom_cfg = os.path.expanduser("~/.colab-cli-oauth-config.json")
    if os.path.exists(custom_cfg):
        with open(custom_cfg, "r") as f:
            return json.load(f)
    try:
        from colab_cli import auth
        config_resource = resources.files("colab_cli").joinpath("oauth_config.json")
        if config_resource.is_file():
            return json.loads(config_resource.read_text())
    except Exception as e:
        pass
    raise RuntimeError("OAuth client configuration not found")

def generate_url():
    from colab_cli import auth
    os.makedirs(TOKEN_DIR, exist_ok=True)
    client_config = get_client_config()
    flow = auth.InstalledAppFlow.from_client_config(client_config, auth.PUBLIC_SCOPES)
    flow.redirect_uri = auth.REMOTE_REDIRECT_URI
    auth_url, state = flow.authorization_url(prompt="consent", token_usage="remote")
    
    with open(FLOW_STATE_PATH, "w") as f:
        json.dump({
            "code_verifier": getattr(flow, "code_verifier", None),
            "state": state
        }, f)
        
    print(json.dumps({"success": True, "auth_url": auth_url, "state": state}))

def exchange_code(code):
    from colab_cli import auth
    if not os.path.exists(FLOW_STATE_PATH):
        print(json.dumps({"success": False, "error": "No pending auth flow found. Call generate-url first."}))
        return
        
    with open(FLOW_STATE_PATH, "r") as f:
        flow_data = json.load(f)
        
    client_config = get_client_config()
    flow = auth.InstalledAppFlow.from_client_config(client_config, auth.PUBLIC_SCOPES)
    flow.redirect_uri = auth.REMOTE_REDIRECT_URI
    flow.code_verifier = flow_data.get("code_verifier")
    
    flow.fetch_token(code=code)
    creds = flow.credentials
    os.makedirs(TOKEN_DIR, exist_ok=True)
    with open(TOKEN_PATH, "w") as f:
        f.write(creds.to_json())
        
    if os.path.exists(FLOW_STATE_PATH):
        os.remove(FLOW_STATE_PATH)
        
    print(json.dumps({"success": True, "message": "Successfully authenticated with Google Colab"}))

def save_token(token_json_str):
    os.makedirs(TOKEN_DIR, exist_ok=True)
    data = json.loads(token_json_str)
    with open(TOKEN_PATH, "w") as f:
        json.dump(data, f, indent=2)
    print(json.dumps({"success": True, "message": "Token file saved"}))

def status():
    has_token = os.path.exists(TOKEN_PATH)
    token_valid = False
    token_info = {}
    if has_token:
        try:
            with open(TOKEN_PATH, "r") as f:
                token_data = json.load(f)
                token_info["expiry"] = token_data.get("expiry")
                token_info["has_refresh_token"] = bool(token_data.get("refresh_token"))
            token_valid = True
        except Exception as e:
            token_info["error"] = str(e)
            
    # Try colab whoami
    whoami_out = ""
    whoami_ok = False
    try:
        res = subprocess.run(["colab", "whoami"], capture_output=True, text=True, timeout=5)
        if res.returncode == 0:
            whoami_out = res.stdout.strip()
            whoami_ok = True
        else:
            whoami_out = res.stderr.strip()
    except Exception as e:
        whoami_out = str(e)
        
    print(json.dumps({
        "has_token": has_token,
        "token_valid": token_valid,
        "token_info": token_info,
        "whoami": whoami_out,
        "authenticated": whoami_ok
    }))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing command"}))
        sys.exit(1)
        
    cmd = sys.argv[1]
    try:
        if cmd == "generate-url":
            generate_url()
        elif cmd == "exchange-code":
            if len(sys.argv) < 3:
                print(json.dumps({"error": "Missing code argument"}))
                sys.exit(1)
            exchange_code(sys.argv[2])
        elif cmd == "save-token":
            if len(sys.argv) < 3:
                token_str = sys.stdin.read()
            else:
                token_str = sys.argv[2]
            save_token(token_str)
        elif cmd == "status":
            status()
        else:
            print(json.dumps({"error": f"Unknown command {cmd}"}))
            sys.exit(1)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
