import sys

def strip(path, removals):
    data = open(path, encoding='utf-8', newline='').read()
    for r in removals:
        hit = None
        for cand in (r + '\r\n', r + '\n'):
            if cand in data:
                hit = cand
                break
        if hit is None:
            print('NOT FOUND in', path, '->', repr(r))
            sys.exit(1)
        data = data.replace(hit, '', 1)
    out = path + '.mineonly'
    open(out, 'w', encoding='utf-8', newline='').write(data)
    print('ok', path)

strip('src/App.tsx', [
    "  Nationals: () => import('./pages/Nationals'),",
    "const Nationals = lazy(() => loaders.Nationals().then((m) => ({ default: m.Nationals })));",
    '              <Route path="/meets/:slug/nationals" element={<RequireAccount><Nationals /></RequireAccount>} />',
])
strip('src/lib/supabase.ts', [
    "  kind: m.kind ?? 'standard', nationals_config: m.nationalsConfig ?? null,",
    "  phase: s.phase ?? null,",
    "  scratched: s.scratched ?? false,",
    "  ...(r.scratched ? { scratched: true } : {}),",
    "        ...(r.phase ? { phase: r.phase } : {}),",
    "      ...(r.kind && r.kind !== 'standard' ? { kind: r.kind } : {}),",
    "      ...(r.nationals_config ? { nationalsConfig: r.nationals_config } : {}),",
])
