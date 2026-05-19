import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

// Multimodal clip analysis. Holds ANTHROPIC_API_KEY (Supabase secret).
// Input:  { transcript: string, frames: string[] (base64 jpeg) }
// Output: { tag:'talking'|'broll', title:string,
//           tags:{kind:'location'|'action'|'subject',value:string}[] }
// Deployed to project arkzlehcpbzohmxwpntl as `analyze` (verify_jwt=false).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const SYSTEM = [
  'You label short vertical phone video clips for a creator app.',
  'You get 1-4 frames sampled across ONE clip plus its audio transcript',
  '(may be empty). Decide TALKING (a person speaking/presenting to the',
  'camera) vs BROLL (supplemental footage, scenery, objects, action, no',
  'one addressing the camera).',
  'Reply with ONLY minified JSON, no prose, no code fences:',
  '{"tag":"talking|broll","title":"..","tags":[{"kind":"location|action|subject","value":".."}]}',
  'title: 2-5 words on the real topic (from transcript if talking, else',
  "the scene); use 'Intro' if it is clearly an opening/greeting.",
  'tags: 0-3 short lowercase single words for b-roll; [] for talking.',
].join(' ');

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const key = Deno.env.get('ANTHROPIC_API_KEY');
    if (!key) return json({ error: 'ANTHROPIC_API_KEY not set' }, 500);
    const { transcript, frames } = await req.json();
    const imgs: string[] = Array.isArray(frames) ? frames.slice(0, 4) : [];
    const content: unknown[] = [
      {
        type: 'text',
        text:
          'Transcript:\n' +
          (typeof transcript === 'string' && transcript.trim()
            ? transcript.trim().slice(0, 4000)
            : '(no speech detected)'),
      },
      ...imgs.map((data) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data },
      })),
    ];
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!r.ok) {
      return json({ error: `anthropic_${r.status}`, detail: await r.text() }, 502);
    }
    const data = await r.json();
    const text: string = data?.content?.[0]?.text ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: 'no_json', raw: text }, 502);
    const parsed = JSON.parse(m[0]);
    const tag = parsed.tag === 'talking' ? 'talking' : 'broll';
    const title =
      typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 60) : '';
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags
          .filter(
            (t: { kind?: string; value?: string }) =>
              t &&
              ['location', 'action', 'subject'].includes(String(t.kind)) &&
              typeof t.value === 'string' &&
              t.value.trim()
          )
          .slice(0, 3)
          .map((t: { kind: string; value: string }) => ({
            kind: t.kind,
            value: t.value.trim().toLowerCase().slice(0, 24),
          }))
      : [];
    return json({ tag, title, tags });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
