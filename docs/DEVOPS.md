# DevOps: Infrastructure Decisions, Costs and Optimisation

Living record of how ResumeRound's servers are set up, **why** each choice was made, what it
costs, and how to cut costs later. Review it before changing infrastructure, and when the AWS free
tier or credits run out.

Last updated: 09 Oct 2026 · Stage: **dev / MVP-4 spike server** (no production traffic yet).

> **Prices are approximate** on-demand rates for Mumbai (`ap-south-1`) as of Oct 2026, rounded,
> excluding tax. Always confirm on the AWS pricing pages or in Cost Explorer before deciding.

---

## 1. Current environment at a glance

| Component                                        | Where it runs                                                                                         | Notes                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Frontend (Next.js)                               | Developer laptops (`localhost:3000`); Vercel later                                                    |                                                             |
| Backend API + job worker                         | Developer laptops (`npm run dev`)                                                                     | Connects to Atlas and to Janus on AWS                       |
| MongoDB                                          | MongoDB Atlas, cluster `ResumeRoundCluster`                                                           | Managed; dev and prod databases on the same cluster for now |
| Janus (WebRTC media server) + coturn (STUN/TURN) | **AWS EC2** `resumeround-janus-dev` (`i-0df4291341438b121`, Elastic IP `16.178.17.240`, `ap-south-1`) | Shared dev server; also hosts the MVP-4 spike               |
| AI bot (spike prototypes)                        | AWS EC2, next to Janus                                                                                | See section 3 for why                                       |
| Object storage                                   | Local disk (`STORAGE_DRIVER=local`)                                                                   | S3 bucket not created yet                                   |
| AI provider                                      | Mock (`AI_PROVIDER=mock`)                                                                             | No Anthropic key yet                                        |

---

## 2. Decision: AWS server vs local Linux (WSL) for Janus

Janus does not run natively on Windows, so it needs a Linux environment.

| Option                             | Pros                                                                                                                                                                                  | Cons                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ubuntu under WSL on the laptop** | Free; works offline; fast to iterate                                                                                                                                                  | Needs admin rights and a restart to install; laptop is behind a home router (NAT), so it does not test real network conditions; each developer needs their own |
| **AWS EC2** (chosen)               | Real internet path (NAT, latency) like production; one shared dev server for the whole team; becomes the base for production; settles the PRD open question "self-host Janus on EC2?" | Costs money (section 6); needs an AWS account                                                                                                                  |

**Decision:** AWS EC2. A local WSL Janus stays optional for offline work.

---

## 3. What can run on a laptop vs on the server

| Piece                                             | On a laptop, with Janus on AWS? | Why                                                                                                                                    |
| ------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend in the browser                           | Yes                             | The browser connects out to Janus, like any video-call app                                                                             |
| Backend API                                       | Yes                             | Calls Janus's HTTP API on AWS to create rooms (port 8088 open to developer IPs)                                                        |
| AI bot, **option B: Node WebRTC peer** (`werift`) | Yes                             | Connects outward like a browser, so the home router is not a problem                                                                   |
| AI bot, **option A: RTP forwarding**              | **No**                          | Janus must send audio _to_ the bot, and a laptop behind a router (NAT) cannot be reached. The bot must run on the server next to Janus |

**Consequence:** during the spike both bot prototypes run on the EC2 server (also where the bot lives
in production, so the comparison is fair). Code is written in the repo and run on the server over
SSH.

---

## 4. AWS setup choices and reasons

### 4.1 Region: Mumbai `ap-south-1`

- Closest region to the team and the first users in India: lower call latency, which matters
  for the ≤ 2 s turn-latency target.
- Matches the S3 region in `.env` (`S3_REGION=ap-south-1`), so storage and compute stay in one
  region (no cross-region transfer fees).

### 4.2 Operating system image (AMI): Ubuntu Server 24.04 LTS, 64-bit x86

| Option               | Verdict | Reason                                                                                                                                               |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ubuntu 24.04 LTS** | Chosen  | Mature (2.5 years of fixes); Janus, coturn and Node.js audio libraries are widely tested on it; security updates until 2029 (longer with Ubuntu Pro) |
| Ubuntu 26.04 LTS     | Not now | Released April 2026; packages and guides still catching up. Revisit for production in 2027                                                           |
| 64-bit (Arm)         | Not now | `t3.small` is an x86 instance; the image must match. Arm becomes relevant with Graviton instances (section 7)                                        |

### 4.3 Instance type: `t3.small` (2 vCPU, 2 GB RAM)

| Option                          | Approx. cost/month (24×7) | Verdict                                                       |
| ------------------------------- | ------------------------- | ------------------------------------------------------------- |
| `t3.micro` (2 vCPU, 1 GB)       | ~$8                       | Too little memory for Janus + coturn + Node bot + build tools |
| **`t3.small` (2 vCPU, 2 GB)**   | **~$16**                  | Chosen: enough for the spike and a shared dev server          |
| `t3.medium` (2 vCPU, 4 GB)      | ~$33                      | Only if load tests need it                                    |
| `t4g.small` (Arm, 2 vCPU, 2 GB) | ~$13                      | ~20% cheaper; candidate after the spike (section 7)           |

`t3` instances are "burstable": they earn CPU credits while idle and spend them under load. Fine for
dev; production sizing comes from the PRD target of 20-30 interviews per bot on 2 vCPU, to be
load-tested.

### 4.4 Storage: 20 GiB gp3

| Size            | Approx. cost/month | Verdict                                                                                                                           |
| --------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 8 GiB (default) | ~$0.75             | Too tight: Ubuntu ~3 GB + Janus and build deps + Node.js + `node_modules` (~0.5 GB) + coturn + logs. A full disk crashes services |
| 12-15 GiB       | ~$1.10-1.40        | Workable minimum for the spike                                                                                                    |
| **20 GiB**      | **~$1.85**         | Chosen: headroom for logs and builds                                                                                              |

- **gp3** (not gp2): cheaper per GB and performance is configurable.
- Disks can be **increased** later without downtime but **never shrunk**, so do not over-provision.

### 4.5 Fixed public IP: Elastic IP

- Janus must advertise a stable public IP to browsers (its `nat_1_1_mapping` setting); a normal
  public IP changes every time the instance stops.
- **Cost:** AWS charges for every public IPv4 address, about **$3.65/month**, whether the instance is
  running or stopped (since Feb 2024). An Elastic IP therefore costs the same as an auto-assigned
  IP while running, and keeps the same address while stopped.
- **Release** the Elastic IP when the server is deleted; an unattached one keeps billing.

### 4.6 Key pair: `resumeround-dev` (RSA, `.pem`)

- Stored on the developer laptop at `D:\ResumeRound\AWS\resumeround-dev-key-pair.pem` (outside
  any git repo). It can be downloaded **once**; if lost, a new key must be added to the instance.
- **Never** commit it, paste its contents in chat, or share it. Share access by adding each
  person's own public key to the server instead.
- SSH accepts only this key (no passwords).

### 4.7 Firewall (security group `resumeround-janus-dev`)

Since 13 Oct 2026 every rule is open to Anywhere (`0.0.0.0/0`) on the **dev** server, so the
team and the frontend can connect from any network without editing rules when an IP changes.

| Port        | Protocol  | Source   | Purpose            | What still protects it                                        |
| ----------- | --------- | -------- | ------------------ | ------------------------------------------------------------- |
| 22          | TCP       | Anywhere | SSH                | Key-only login (`.pem`); no passwords                         |
| 8088        | TCP       | Anywhere | Janus HTTP API     | Signed token on every request; admin key to create rooms      |
| 8188        | TCP       | Anywhere | Janus WebSocket    | Signed token on every request                                 |
| 10000-10200 | UDP       | Anywhere | Audio (RTP)        | Only flows inside a joined, PIN-protected room                |
| 3478        | UDP + TCP | Anywhere | STUN/TURN (coturn) | Time-limited credentials; relaying to private networks denied |

Accepted for dev because the server holds no candidate data and is stopped when not in use.
Conditions:

- Password login stays off (`sudo sshd -T | grep -i passwordauthentication` → `no`) and
  automatic security updates stay on (`systemctl is-enabled unattended-upgrades` → `enabled`).
- One rule per port; never an "All traffic" rule, which would also expose anything started on the
  server later.
- **Production:** 22 and 8088 must not be public. SSH from known IPs only (or AWS Session
  Manager), and 8088 reachable only from the backend and bot servers' security group.

### 4.8 Server software and security settings

Installed and configured by [`infra/dev-server/setup.sh`](../infra/dev-server/README.md)
(idempotent; configs are templates in the repo, secrets are generated on the server into
`/etc/resumeround/secrets.env`, root-only, never committed).

| Item                 | Setting                                                             | Why                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Janus                | 1.1.2 (Ubuntu package)                                              | Security updates via `apt`; recent enough for AudioBridge RTP forwarding and plain-RTP participants. Build from source only if the spike needs a newer feature |
| coturn               | 4.6.1 (Ubuntu package)                                              | Same                                                                                                                                                           |
| Node.js              | 22 (NodeSource)                                                     | Same major version as the backend (`engines: >=22.12`)                                                                                                         |
| UDP ports            | Janus 10000-10100, coturn relays 10101-10200                        | Both inside the single security-group range 10000-10200                                                                                                        |
| Janus auth           | Signed tokens (`token_auth_secret`), short-lived, scoped to plugins | Browsers never hold a secret; the backend issues tokens (PRD: short-lived join tokens). Verified: no token / expired token → 403, wrong plugin → 405           |
| Janus admin API      | Port 7088 on localhost only                                         | Reach it with an SSH tunnel; never exposed                                                                                                                     |
| AudioBridge          | Room creation and RTP forwarding need the admin key                 | A join token alone cannot create rooms or tap audio                                                                                                            |
| coturn auth          | Time-limited credentials from a shared secret (TURN REST API)       | Credentials expire; returned by the backend with the ICE servers                                                                                               |
| coturn relay targets | Private networks denied, except Janus on this host                  | Stops TURN being used to reach the AWS VPC or metadata service                                                                                                 |
| Unused Janus modules | SIP, streaming, recording, Lua, MQTT, RabbitMQ, ... disabled        | Less memory and attack surface                                                                                                                                 |

Verified from a developer laptop: HTTP 8088 and WebSocket 8188 reachable, STUN on UDP 3478 answers.

---

## 5. Credentials inventory

| Credential                    | Needed for                            | Status                                                     | Where it lives                                                         |
| ----------------------------- | ------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| AWS account (console login)   | Creating and managing servers         | ✅ In use                                                  | Owner only; enable MFA                                                 |
| EC2 key pair `.pem`           | SSH to the dev server                 | ✅ Created during setup                                    | Laptop `~/.ssh`, never in the repo                                     |
| MongoDB Atlas user            | Database                              | ✅ In use                                                  | `.env` (git-ignored). **Rotate the password**: it was shared in a chat |
| Janus API secret / admin key  | Backend ↔ Janus                       | Set during installation                                    | Server config + backend `.env`                                         |
| Anthropic API key             | Real AI interviewer and reports       | ⬜ Not yet                                                 | `.env`                                                                 |
| Deepgram API key              | MVP-4 voice (STT and TTS)             | ✅ Created (role Default); **rotate**: shared in a chat    | `.env` (`DEEPGRAM_API_KEY`)                                            |
| Google TTS API key (optional) | Only if TTS_PROVIDER=google           | ⬜ Not created (Google Cloud India asks ₹1,000 prepayment) | `.env` (`GOOGLE_TTS_API_KEY`)                                          |
| Domain + TLS certificate      | `wss://` for Janus, HTTPS for the API | Domain ✅ owned; TLS ⬜ (Let's Encrypt, free)              | Domain registrar / DNS; certificate on the server                      |
| S3 bucket credentials         | Resume and audio storage              | ⬜ Not yet                                                 | `.env`, or an EC2 instance role in production                          |
| Google OAuth client ID        | Google sign-in                        | ⬜ Not yet                                                 | `.env` (backend and frontend)                                          |

---

## 6. Cost overview (dev server)

| Item                     | While running                                        | While stopped    |
| ------------------------ | ---------------------------------------------------- | ---------------- |
| `t3.small` instance      | ~$16/month (~$0.022/hour)                            | $0               |
| 20 GiB gp3 disk          | ~$1.85/month                                         | ~$1.85/month     |
| Public IPv4 (Elastic IP) | ~$3.65/month                                         | ~$3.65/month     |
| Data transfer out        | First 100 GB/month free (all of AWS), then ~$0.11/GB | -                |
| **Total**                | **~$21.50/month**                                    | **~$5.50/month** |

**Audio traffic is small:** Opus voice is about 30-40 kbps per direction, so a 30-minute interview
moves roughly 15 MB. Even 1,000 interviews a month (~15 GB) stay inside the free 100 GB. AI
(LLM, speech-to-text, text-to-speech) is the dominant cost per interview, not servers (PRD: ~85-90%).

**Free tier:** `t3.small` is not free-tier eligible. Depending on when the account was created, it
has either the classic 12-month free tier (750 hours/month of `t2/t3.micro`, 30 GB disk, 750
hours of public IPv4) or the newer credits-based free plan. Check **Billing → Free Tier** and
**Credits** to see what applies.

---

## 7. Cost optimisation playbook (review when free tier / credits end)

Ordered by effort, smallest first.

| #   | Action                                                                                   | Saves                                                          | When                                    | Watch out for                                                                                      |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | **Budget alert** (Billing → Budgets, e.g. $20/month, email at 80%)                       | Prevents surprises                                             | Now                                     | -                                                                                                  |
| 2   | **Stop the dev server when not in use** (nights, weekends)                               | Up to ~70% of the instance cost                                | Now                                     | Disk and IP still bill (~$5.50/month)                                                              |
| 3   | **Automatic schedule** (EventBridge Scheduler: stop 22:00, start 09:00 on weekdays)      | Same as #2, without remembering                                | When the team uses it daily             | Teammates in other time zones                                                                      |
| 4   | **Right-size** using CloudWatch CPU and memory graphs                                    | Varies                                                         | After 2-4 weeks of real use             | Burst-credit exhaustion on `t3`                                                                    |
| 5   | **Switch to Arm (Graviton) `t4g.small`**                                                 | ~20%                                                           | After the spike picks the bridge option | Native Node modules must have arm64 builds (`@node-rs/argon2` does; check the Opus library chosen) |
| 6   | **Amazon Lightsail** instead of EC2 for dev                                              | Fixed price (~$12/month for 2 GB incl. static IP and transfer) | If dev stays a single small box         | Fewer networking options; check UDP port-range support before moving                               |
| 7   | **Savings Plan or Reserved Instance (1 year)**                                           | ~30-40%                                                        | Production, once usage is steady        | Commitment for 1 year                                                                              |
| 8   | **Combine processes on one box** in early production (API + worker + bot + Janus)        | One server instead of several                                  | Beta (100-300 users)                    | Split when a scaling trigger fires                                                                 |
| 9   | **Remove leftovers**: unattached Elastic IPs, old disk snapshots, stopped test instances | Small but recurring                                            | Monthly review                          | -                                                                                                  |
| 10  | **Do not use Spot instances for Janus or the bot**                                       | -                                                              | -                                       | Spot can be taken back at any time: live calls would drop                                          |

Bigger levers sit outside the server bill (see the Backend Base Document): AI model tiering,
prompt caching, voice-activity gating for speech-to-text, and self-hosting speech-to-text and
text-to-speech once volume justifies it.

---

## 8. Day-to-day operations

| Task                              | How                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| SSH into the server               | `ssh -i D:\ResumeRound\AWS\resumeround-dev-key-pair.pem ubuntu@16.178.17.240`                     |
| SSH or Janus suddenly unreachable | Your IP probably changed: update the developer rules in the security group                        |
| Stop / start to save money        | EC2 → Instances → select → Instance state → Stop / Start (the Elastic IP stays)                   |
| See what you are paying           | Billing → Cost Explorer, filter by service                                                        |
| Give a teammate access            | Add their public SSH key on the server and their IP to the security group; never share the `.pem` |
| Disk filling up                   | `df -h` on the server; increase the volume in EC2 → Volumes → Modify, then grow the filesystem    |

---

## 9. Production differences (later)

- **TLS everywhere:** a domain, HTTPS for the API, `wss://` for Janus on port 443 (reverse proxy),
  TURN over TLS (5349/443) for strict corporate networks.
- **Janus HTTP/admin API private:** reachable only from the API servers (same VPC), not from
  developer IPs.
- **Separate environments:** production database (`resumeroundprod`) not used for development; a
  separate dev database (`resumerounddev`).
- **Instance role instead of keys** for S3 access from EC2.
- **Scaling stages** as in the DevOps and Scaling Plan: start on one box, split API / bot / Janus
  when measured triggers fire.

---

## 10. Open items

- [x] Developer ports: opened to Anywhere for the dev phase (13 Oct 2026); close 22 and 8088
      before production (section 4.7).
- [ ] Create the budget alert.
- [ ] After the spike: decide x86 vs Arm (`t4g`) and EC2 vs Lightsail for dev.
- [ ] DNS: point a subdomain (e.g. `janus-dev.<domain>`) at `16.178.17.240`.
- [ ] Rotate the MongoDB Atlas password.
- [x] Speech providers: Deepgram Nova-3 (STT) and Aura-2 (TTS) for launch; self-host on a GPU
      server once STT + TTS spend passes about $500/month.
- [ ] Rotate the Deepgram key (it was pasted in a chat).
