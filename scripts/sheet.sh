#!/bin/bash
# Usage: scripts/sheet.sh <name> <frames> <w> <h> <cols> "<common query>" "<q1>" "<q2>" ...
S=/tmp/claude-0/-home-claude/9e0f2440-67b6-5946-b6e0-e6ec89a17724/scratchpad/shots
name=$1; frames=$2; w=$3; h=$4; cols=$5; common=$6; shift 6
i=0; files=()
for q in "$@"; do
  f=$S/${name}_$i.png
  timeout 900 node scripts/shot.mjs $f "$common&$q" $frames $w $h 2>&1 | cut -c1-400 | grep -v '^$'
  files+=($f); i=$((i+1))
done
python3 - "$S/$name.png" "$cols" "${files[@]}" <<'PY'
import sys
from PIL import Image
out, cols, files = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
ims=[Image.open(f).convert('RGB') for f in files]
w,h=ims[0].size
rows=(len(ims)+cols-1)//cols
sheet=Image.new('RGB',(w*cols,h*rows),(255,255,255))
for i,im in enumerate(ims): sheet.paste(im,((i%cols)*w,(i//cols)*h))
sheet.save(out)
PY
