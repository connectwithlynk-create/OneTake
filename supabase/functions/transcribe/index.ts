import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

// Thin Deepgram proxy. Holds DEEPGRAM_API_KEY (Supabase secret) so it never
// ships in the app. Caller supplies a short-lived signed URL it already had
// RLS-gated access to create; this function only transcribes it. Returns
// both the full transcript and word-level timings (drives synced captions).
// Deployed to project arkzlehcpbzohmxwpntl (verify_jwt=false). Repo copy of record.
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

type DGWord = {
  word?: string;
  punctuated_word?: string;
  start: number;
  end: number;
};

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
    const alt = data?.results?.channels?.[0]?.alternatives?.[0];
    const transcript: string = alt?.transcript ?? '';
    const raw: DGWord[] = Array.isArray(alt?.words) ? alt.words : [];
    const words = raw.map((w) => ({
      w: w.punctuated_word ?? w.word ?? '',
      s: w.start,
      e: w.end,
    }));
    return json({ transcript, words });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
