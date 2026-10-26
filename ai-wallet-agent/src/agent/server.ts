/**
 * Agent HTTP API (localhost by default). The wallet app polls /proposals and
 * reports outcomes; the chat UI posts to /chat.
 *
 *   POST /chat                  {text}                    -> AgentReply
 *   GET  /proposals             pending proposals
 *   GET  /proposals/:id
 *   POST /proposals/:id/status  {status, txHash?, error?} (wallet -> agent bookkeeping)
 *   GET  /history
 *
 * Every request needs `Authorization: Bearer $AGENT_API_TOKEN`. Even a stolen
 * token only lets someone chat with the agent or read proposals — approving
 * requires the user's device key AND their user share.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parse, stringify } from '../core/json.js';
import type { ProposalStatus } from '../core/types.js';
import type { WalletAgent } from './agent.js';
import type { AgentStore } from './store.js';

const WALLET_SETTABLE: ProposalStatus[] = ['rejected_by_user', 'signed', 'broadcast', 'failed'];

export function startServer(agent: WalletAgent, store: AgentStore, opts: { port: number; host?: string; token: string }) {
	if (opts.token.length < 24) throw new Error('AGENT_API_TOKEN must be at least 24 characters');
	const expected = Buffer.from(`Bearer ${opts.token}`);

	const send = (res: ServerResponse, code: number, body: unknown) => {
		res.writeHead(code, { 'content-type': 'application/json' }).end(stringify(body));
	};
	const readBody = async (req: IncomingMessage) => {
		let raw = '';
		for await (const chunk of req) {
			raw += chunk;
			if (raw.length > 64_000) throw new Error('body too large');
		}
		return raw ? parse<Record<string, unknown>>(raw) : {};
	};

	const server = createServer(async (req, res) => {
		const auth = Buffer.from(req.headers.authorization ?? '');
		if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(res, 401, { error: 'unauthorized' });
		const url = new URL(req.url ?? '/', 'http://localhost');
		try {
			if (req.method === 'POST' && url.pathname === '/chat') {
				const { text } = await readBody(req);
				if (typeof text !== 'string' || !text.trim() || text.length > 2_000) return send(res, 400, { error: 'text required (≤2000 chars)' });
				return send(res, 200, await agent.handle(text));
			}
			if (req.method === 'GET' && url.pathname === '/proposals') return send(res, 200, store.pending());
			if (req.method === 'GET' && url.pathname === '/history') return send(res, 200, store.history());
			const m = url.pathname.match(/^\/proposals\/([\w-]+)(\/status)?$/);
			if (m && req.method === 'GET' && !m[2]) {
				const p = store.proposals.get(m[1]!);
				return p ? send(res, 200, p) : send(res, 404, { error: 'not found' });
			}
			if (m && req.method === 'POST' && m[2]) {
				const body = await readBody(req);
				const status = body.status as ProposalStatus;
				if (!WALLET_SETTABLE.includes(status)) return send(res, 400, { error: 'invalid status' });
				store.updateStatus(m[1]!, status, { txHash: body.txHash as string | undefined, error: body.error as string | undefined });
				return send(res, 200, { ok: true });
			}
			send(res, 404, { error: 'not found' });
		} catch (e) {
			send(res, 500, { error: (e as Error).message });
		}
	});
	server.listen(opts.port, opts.host ?? '127.0.0.1');
	return server;
}
