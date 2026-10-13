# Dev media server (Janus + coturn)

Configuration and setup for `resumeround-janus-dev` (AWS EC2, Ubuntu 24.04). Decisions, costs and
the firewall rules are in [docs/DEVOPS.md](../../docs/DEVOPS.md).

| Path                     | What                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `setup.sh`               | Installs Janus, coturn and Node.js 22, renders the configs, restarts services. Idempotent |
| `janus/*.jcfg`           | Janus core, transports and plugin configs (templates)                                     |
| `coturn/turnserver.conf` | STUN/TURN config (template)                                                               |

`${VARIABLES}` in the templates are filled in on the server from the instance metadata and from
`/etc/resumeround/secrets.env`, which `setup.sh` generates once (root-only). **No secrets are stored
in this repo.**

## Apply or update

On a new server, attach the Elastic IP **before** the first run: the script writes the public IP
into the configs. Full rebuild steps: [docs/DEVOPS.md, section 11](../../docs/DEVOPS.md).

From the repo root on your laptop:

```bash
scp -i <key.pem> -r infra/dev-server ubuntu@<server-ip>:~/
ssh -i <key.pem> ubuntu@<server-ip> 'sudo bash ~/dev-server/setup.sh'
```

## Ports

| Port            | Used by                                                 |
| --------------- | ------------------------------------------------------- |
| TCP 8088        | Janus HTTP API (backend)                                |
| TCP 8188        | Janus WebSocket (browsers, janus.js)                    |
| TCP 7088        | Janus admin API, **localhost only** (use an SSH tunnel) |
| UDP 10000-10100 | Janus media (RTP)                                       |
| UDP/TCP 3478    | coturn STUN/TURN                                        |
| UDP 10101-10200 | coturn relays                                           |

## Secrets the backend needs

Read them on the server with `sudo cat /etc/resumeround/secrets.env`, and copy into the backend
`.env` (git-ignored) as needed:

| Secret                      | Used for                                                               |
| --------------------------- | ---------------------------------------------------------------------- |
| `JANUS_TOKEN_SECRET`        | Signing short-lived Janus tokens for the backend, the bot and browsers |
| `AUDIOBRIDGE_ADMIN_KEY`     | Creating and destroying interview rooms, RTP forwarding                |
| `TEXTROOM_ADMIN_KEY`        | Creating caption rooms                                                 |
| `TURN_SECRET`, `TURN_REALM` | Generating time-limited TURN credentials                               |
| `JANUS_ADMIN_SECRET`        | Admin/monitoring API (via SSH tunnel only)                             |
