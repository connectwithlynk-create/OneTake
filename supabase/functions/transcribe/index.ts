import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

// Thin Deepgram proxy. Holds DEEPGRAM_API_KEY (Supabase secret) so it never
// ships in the app. The caller supplies a short-lived signed URL it already
// had RLS-gated access to create; this function only transcribes it.
// Deployed to project arkzlehcpbzohmxwpntl as function `transcribe`
// (verify_jwt=false). Repo copy of record.
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const { signedUrl } = await req.json();
    if (!signedUrl || typeof signedUrl !== 'string') {
      return json({ error: 'signedUrl required' }, 400);
    }
    const key = Deno.env.get('DEEPGRAM_API_KEY');
    if (!key) return json({ error: 'DEEPGRAM_API_KEY not set' }, 500);
    const dg = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true',
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: signedUrl }),
      },
    );
    if (!dg.ok) {
      return json({ error: `deepgram_${dg.status}`, detail: await dg.text() }, 502);
    }
    const data = await dg.json();
    const transcript =
      data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    return json({ transcript });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
