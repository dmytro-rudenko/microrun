import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent.parent
base = (root / 'shared/base.css').read_text()
data = (root / 'shared/data.js').read_text() + '\n' + (root / 'shared/views.js').read_text()
for name in sys.argv[1:] or [p.stem for p in (root / 'src').glob('*.html')]:
    src = (root / 'src' / f'{name}.html').read_text()
    out = root / 'variants' / name / 'index.html'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(src.replace('/*BASE*/', base).replace('/*DATA*/', data))
    print(out.relative_to(root))
