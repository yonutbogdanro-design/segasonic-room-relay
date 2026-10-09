# SegaSonic PC room relay

This service connects up to three players by room code. Both host and guests make outbound secure WebSocket connections. Players do not share IP addresses or open router ports. The game host must keep the game open. This repository contains no game ROM, artwork, music or executable.

## Deploy on Render

Create a **Web Service** from this repository, with Node runtime, Frankfurt region (or the region nearest the players), **Free** instance, build command `npm ci`, start command `npm start`, and health check `/healthz`. Keep **one instance**. The included `render.yaml` also describes these settings. No database or paid add-on is required. Keep automatic deploys off during games.

After deployment, `/healthz` should report `ok: true`. The game endpoint is `wss://YOUR-SERVICE.onrender.com/relay`. Use the actual URL Render assigns; the placeholder is not an existing service.

Free services can sleep after inactivity and need about a minute to wake. Render restarts and deployments disconnect rooms; hosts then create new rooms. Rooms exist in memory, not on disk. This relay does not provide global persistent leaderboards: scores stay with the game's host. See https://render.com/docs/free and https://render.com/docs/websocket for current limits.

## Run and test locally

Node 22 or later: `npm ci`, `npm test`, `npm start`. HTTP listens on `PORT` (default 10000). Development endpoint: `ws://127.0.0.1:10000/relay`. Use **wss** on the internet; Render supplies TLS automatically.

## Protocol and limits

Text WebSocket messages: `CREATE SSPC20261009B BOT PUBLIC NAME`, `JOIN SSPC20261009B CODE NAME`, `LIST SSPC20261009B`. The service responds with `CREATED CODE`, `JOINED CODE`, `PEER ID`, `LEFT ID`, or `ERROR REASON`. A host sends `SEND ID\nGAME_LINES`; guests use ID 0. Received packets are `DATA ID\nGAME_LINES`. `LOCK 1` closes the lobby to new players; `LOCK 0` reopens it. `DROP ID` removes a guest. `PING` receives `PONG`.

Public rooms may appear in the directory; private rooms require the randomly generated eight-character code. Codes are invitations, not identity verification. Never use a code as a password elsewhere. Connections and payloads are bounded, and only supported game command types are forwarded. Relay and hosting operators necessarily receive connection metadata, but other players are not sent IP addresses. No chat, files or arbitrary TCP forwarding are supported.

