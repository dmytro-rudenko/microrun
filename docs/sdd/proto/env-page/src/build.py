import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
shared = root / 'shared'
for v in ('a', 'b', 'c', 'a2'):
    out = root / 'variants' / v
    out.mkdir(parents=True, exist_ok=True)
    css = (shared / 'base.css').read_text() + (root / 'src' / f'{v}.css').read_text()
    js = (shared / 'data.js').read_text() + (root / 'src' / f'{v}.js').read_text() + (shared / 'app.js').read_text()
    (out / 'index.html').write_text(f'''<meta charset="utf-8">
<title>Сторінка оточення {v.upper()}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>{css}</style>
<div id="app"></div>
<aside id="panel" aria-live="polite"></aside>
<script>{js}
render();</script>
''')
    print(out / 'index.html')
