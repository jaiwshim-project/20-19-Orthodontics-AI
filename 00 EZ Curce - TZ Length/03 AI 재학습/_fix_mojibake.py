# api/classify-diagnosis.js 의 깨진 한글 3줄 복원 (기존 커밋부터 이미 깨져 있었다).
#
# ⚠️ 깨진 원문을 스크립트에 리터럴로 넣으면 안 된다 — 셸 히어독을 거치는 동안
#    다시 재인코딩되어 매칭이 0건이 된다(실측). 줄 번호 + 따옴표 안쪽만 교체한다.
import io, re, sys

sys.stdout.reconfigure(encoding='utf-8')
PATH = '../../api/classify-diagnosis.js'

# (줄번호, 그 줄에 반드시 있어야 하는 앵커, 복원할 한국어)
FIXES = [
    (209, 'error: `', '필수 이미지가 부족합니다: ${missing.join(\', \')}'),
    (266, 'status(503)', '이미지 기반 분류를 위한 AI API 키가 설정되지 않았습니다.'),
    (271, 'status(502)', 'AI 응답에서 JSON 분류 결과를 추출하지 못했습니다.'),
]

text = io.open(PATH, encoding='utf-8').read()
lines = text.split('\n')
changed = 0
for lineno, anchor, korean in FIXES:
    idx = lineno - 1
    line = lines[idx]
    assert anchor in line, ('앵커 불일치', lineno, anchor)
    # 백틱 문자열이면 백틱, 아니면 단일 따옴표 안쪽을 통째로 바꾼다
    if '`' in line:
        new = re.sub(r'`[^`]*`', lambda m: '`' + korean + '`', line, count=1)
    else:
        new = re.sub(r"'[^']*'", lambda m: "'" + korean + "'", line, count=1)
    assert new != line, ('교체 실패', lineno)
    lines[idx] = new
    changed += 1
    print('%d 줄 복원: %s' % (lineno, korean[:40]))

io.open(PATH, 'w', encoding='utf-8').write('\n'.join(lines))
print('총 %d 줄 복원' % changed)
