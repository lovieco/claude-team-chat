#!/usr/bin/env node
// team-chat relay: rooms behind 4-character codes, messages and presence over
// plain HTTP. No dependencies.
//
//   PORT=47800 CHAT_TOKEN=some-secret node relay.mjs
//
// GET  /health                          -> { ok, epoch }
// POST /rooms                           -> { code }      makes a room (needs the token when CHAT_TOKEN is set)
// GET  /rooms/:code?after=<id>&name=<n> -> { epoch, messages, online }   (also marks <n> online)
// POST /rooms/:code/messages            -> { message }   body { from, text, via? }
// POST /rooms/:code/leave               -> { ok }        body { name }
//
// A code is 4 characters of A-Z, a-z and 0-9, case-sensitive, and it is the
// room's key: only the relay makes them, at random, and an address that asks
// for too many codes that do not exist is turned away for a while.
//
// Everything lives in memory: a restart empties the rooms and starts a new epoch.

import { createServer } from 'node:http'
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

const PORT = Number(process.env.PORT ?? 47800)
const HOST = process.env.HOST ?? '0.0.0.0'
const TOKEN = process.env.CHAT_TOKEN ?? ''
const TRUST_PROXY = process.env.TRUST_PROXY === '1' // read the client address from X-Forwarded-For
const EPOCH = randomUUID()

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const CODE = /^[A-Za-z0-9]{4}$/
const KEEP = 500 // messages kept per room
const BACKLOG = 50 // messages a new reader gets
const ONLINE_MS = 15_000 // seen within this long counts as online
const IDLE_MS = 24 * 60 * 60 * 1000 // a room nobody has been in for this long is removed
const MAX_ROOMS = 10_000
const WINDOW_MS = 10 * 60 * 1000
const MAX_MISSES = 20 // wrong codes per address per window
const MAX_CREATES = 30 // rooms made per address per window
const MAX_BODY = 16_384
const MAX_TEXT = 4_000
const NAME = /^[^\u0000-\u001f]{1,40}$/

/** @type {Map<string, { seq: number, messages: object[], seen: Map<string, number>, lastActive: number }>} */
const rooms = new Map()
/** @type {Map<string, { misses: number[], creates: number[] }>} */
const clients = new Map()

function clientOf(req) {
  const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : ''
  const address = forwarded || req.socket.remoteAddress || 'unknown'
  let client = clients.get(address)
  if (!client) {
    client = { misses: [], creates: [] }
    clients.set(address, client)
  }
  const since = Date.now() - WINDOW_MS
  client.misses = client.misses.filter(at => at > since)
  client.creates = client.creates.filter(at => at > since)
  return client
}

function newCode() {
  for (;;) {
    let code = ''
    for (let i = 0; i < 4; i++) code += ALPHABET[randomInt(ALPHABET.length)]
    if (!rooms.has(code)) return code
  }
}

function online(room) {
  const now = Date.now()
  for (const [name, at] of room.seen) if (now - at > ONLINE_MS) room.seen.delete(name)
  return [...room.seen.keys()].sort((a, b) => a.localeCompare(b))
}

function isAuthorized(req) {
  if (!TOKEN) return true
  const given = Buffer.from(req.headers.authorization ?? '')
  const wanted = Buffer.from(`Bearer ${TOKEN}`)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://relay')
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, epoch: EPOCH })
    if (parts[0] !== 'rooms') return send(res, 404, { error: 'not found' })
    const client = clientOf(req)

    if (req.method === 'POST' && parts.length === 1) {
      if (!isAuthorized(req)) return send(res, 401, { error: 'bad or missing token' })
      if (client.creates.length >= MAX_CREATES) return send(res, 429, { error: 'too many new rooms; wait a few minutes' })
      if (rooms.size >= MAX_ROOMS) return send(res, 503, { error: 'the relay is full' })
      const code = newCode()
      rooms.set(code, { seq: 0, messages: [], seen: new Map(), lastActive: Date.now() })
      client.creates.push(Date.now())
      return send(res, 201, { code })
    }

    if (client.misses.length >= MAX_MISSES) return send(res, 429, { error: 'too many wrong codes; wait a few minutes' })
    const code = parts[1] ?? ''
    const room = CODE.test(code) ? rooms.get(code) : undefined
    if (!room) {
      client.misses.push(Date.now())
      return send(res, 404, { error: `no room has the code ${CODE.test(code) ? code : '(not 4 letters or digits)'}` })
    }
    room.lastActive = Date.now()

    if (req.method === 'GET' && parts.length === 2) {
      const name = url.searchParams.get('name') ?? ''
      if (NAME.test(name)) room.seen.set(name, Date.now())
      const after = Number(url.searchParams.get('after') ?? 0) || 0
      const messages = after > 0 ? room.messages.filter(m => m.id > after) : room.messages.slice(-BACKLOG)
      return send(res, 200, { epoch: EPOCH, messages, online: online(room) })
    }

    if (req.method === 'POST' && parts[2] === 'messages') {
      const { from, text, via } = await readJson(req)
      if (typeof from !== 'string' || !NAME.test(from)) return send(res, 400, { error: 'from must be a name of 1-40 characters' })
      if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'text is empty' })
      if (text.length > MAX_TEXT) return send(res, 413, { error: `text is over ${MAX_TEXT} characters` })
      const message = { id: ++room.seq, from, text: text.trim(), at: Date.now(), ...(via === 'claude' ? { via } : {}) }
      room.messages.push(message)
      if (room.messages.length > KEEP) room.messages.splice(0, room.messages.length - KEEP)
      room.seen.set(from, Date.now())
      return send(res, 201, { message })
    }

    if (req.method === 'POST' && parts[2] === 'leave') {
      const { name } = await readJson(req)
      if (typeof name === 'string') room.seen.delete(name)
      return send(res, 200, { ok: true })
    }

    return send(res, 404, { error: 'not found' })
  } catch (error) {
    return send(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
  }
})

// Drop idle rooms and forget addresses with nothing left in their window.
setInterval(() => {
  const now = Date.now()
  for (const [code, room] of rooms) if (now - room.lastActive > IDLE_MS) rooms.delete(code)
  for (const [address, client] of clients) {
    if (!client.misses.some(at => now - at < WINDOW_MS) && !client.creates.some(at => now - at < WINDOW_MS)) {
      clients.delete(address)
    }
  }
}, 60_000).unref()

server.listen(PORT, HOST, () => {
  console.log(
    `team-chat relay on http://${HOST}:${PORT}${TOKEN ? ' (a token is needed to make rooms)' : ' (anyone who can reach it can make rooms)'}`,
  )
})
