"""Build the client presentation map from 03-presentation-map.md."""

import json
import re
import uuid
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape


HERE = Path(__file__).parent
SOURCE = HERE / "03-presentation-map.md"
OUTPUT = HERE / "06-pilgrim-accommodation-rtl.xmind"
PALETTE = ["#166E8A", "#6D4DB2", "#C8782C", "#258269",
           "#B75169", "#376CAD", "#95539B", "#48744F"]


def style(properties):
    return {"id": uuid.uuid4().hex, "properties": properties}


def topic(title, level, branch_index=0):
    color = PALETTE[branch_index % len(PALETTE)]
    node = {"id": uuid.uuid4().hex, "title": title}
    if level == 1:
        node["structureClass"] = "org.xmind.ui.logic.left"
        node["style"] = style({
            "fo:font-family": "Tahoma", "fo:font-size": "23pt",
            "fo:font-weight": "700", "fo:color": "#FFFFFF",
            "fo:text-align": "right",
            "svg:fill": "#183153", "fill-pattern": "solid",
            "border-line-color": "#183153", "border-line-width": "0pt",
            "shape-class": "org.xmind.topicShape.roundedRect",
            "line-color": "#CBD5E1", "line-width": "2pt"})
    elif level == 2:
        node["branchState"] = "folded"
        node["style"] = style({
            "fo:font-family": "Tahoma", "fo:font-size": "17pt",
            "fo:font-weight": "700", "fo:color": "#FFFFFF",
            "fo:text-align": "right",
            "svg:fill": color, "fill-pattern": "solid",
            "border-line-color": color, "border-line-width": "0pt",
            "shape-class": "org.xmind.topicShape.roundedRect",
            "line-color": color, "line-width": "2pt"})
    elif level == 3:
        node["style"] = style({
            "fo:font-family": "Tahoma", "fo:font-size": "14pt",
            "fo:font-weight": "700", "fo:color": "#172A43",
            "fo:text-align": "right",
            "svg:fill": "#F0F5F9", "fill-pattern": "solid",
            "border-line-color": color, "border-line-width": "1pt",
            "shape-class": "org.xmind.topicShape.roundedRect",
            "line-color": color, "line-width": "1.5pt"})
    else:
        node["style"] = style({
            "fo:font-family": "Tahoma", "fo:font-size": "12pt",
            "fo:font-weight": "400", "fo:color": "#34465B",
            "fo:text-align": "right",
            "svg:fill": "#FFFFFF", "fill-pattern": "solid",
            "border-line-color": "#D1DBE5", "border-line-width": "1pt",
            "shape-class": "org.xmind.topicShape.roundedRect",
            "line-color": color, "line-width": "1pt"})
    return node


def add(parent, child):
    parent.setdefault("children", {}).setdefault("attached", []).append(child)


def sheet(title, root):
    return {
        "id": uuid.uuid4().hex, "title": title, "rootTopic": root,
        "relationships": [],
        "style": style({"svg:fill": "#F8FAFD"}),
        "theme": {
            "map": style({"svg:fill": "#F8FAFD",
                          "multi-line-colors": " ".join(PALETTE),
                          "color-list": "#183153 #F8FAFD " + " ".join(PALETTE),
                          "line-tapered": "none"}),
            "centralTopic": style({"fo:font-family": "Tahoma", "fo:font-size": "23pt",
                                   "fo:font-weight": "700", "fo:color": "#FFFFFF",
                                   "fo:text-align": "right",
                                   "svg:fill": "#183153", "fill-pattern": "solid",
                                   "shape-class": "org.xmind.topicShape.roundedRect"}),
            "mainTopic": style({"fo:font-family": "Tahoma", "fo:font-size": "17pt",
                                "fo:font-weight": "700", "fo:color": "#FFFFFF",
                                "fo:text-align": "right",
                                "shape-class": "org.xmind.topicShape.roundedRect"}),
            "subTopic": style({"fo:font-family": "Tahoma", "fo:font-size": "13pt",
                               "fo:color": "#172A43", "fo:text-align": "right",
                               "shape-class": "org.xmind.topicShape.roundedRect"})
        }
    }


def xml_topic(node):
    children = node.get("children", {}).get("attached", [])
    inner = "".join(xml_topic(child) for child in children)
    if children:
        inner = f'<children><topics type="attached">{inner}</topics></children>'
    return f'<topic id="{node["id"]}"><title>{escape(node["title"])}</title>{inner}</topic>'


entries = []
current_entry = None
paragraphs = []


def flush_note():
    if current_entry is not None and paragraphs:
        content = "\n".join(paragraphs).strip()
        if content:
            current_entry["note"] = content
    paragraphs.clear()


for line in SOURCE.read_text(encoding="utf-8").splitlines():
    match = re.match(r"^(#{1,6})\s+(.+)$", line)
    if match:
        flush_note()
        current_entry = {"level": len(match.group(1)),
                         "title": match.group(2).strip()}
        entries.append(current_entry)
    elif line.strip():
        paragraphs.append(line.strip())
flush_note()

assert entries and entries[0]["level"] == 1
root_title = entries[0]["title"]
root = topic(root_title, 1)
root["notes"] = {"plain": {"content":
    "برای دیدن جزئیات، شاخه‌های رنگی را یکی‌یکی باز کنید. "
    "عنوان‌ها کوتاه‌اند؛ توضیح کامل هر حالت در یادداشت همان گره است."}}
stack = {1: root}
branch_index = -1
for entry in entries[1:]:
    level, title = entry["level"], entry["title"]
    if level == 2:
        branch_index += 1
    node = topic(title, level, branch_index)
    if entry.get("note"):
        node["notes"] = {"plain": {"content": entry["note"]}}
    assert level - 1 in stack
    add(stack[level - 1], node)
    stack[level] = node
    for key in list(stack):
        if key > level:
            del stack[key]

sheets = [sheet("طرح کامل در یک صفحه", root)]
content_xml = ('<?xml version="1.0" encoding="UTF-8"?>'
               '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" version="2.0">'
               + ''.join(f'<sheet id="{s["id"]}">{xml_topic(s["rootTopic"])}'
                         f'<title>{escape(s["title"])}</title></sheet>' for s in sheets)
               + '</xmap-content>')
metadata = {"dataStructureVersion": "2", "layoutEngineVersion": "3",
            "creator": {"name": "Codex", "version": "1"}}
manifest = {"file-entries": {name: {} for name in
            ("content.json", "content.xml", "metadata.json")}}

with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("content.json", json.dumps(sheets, ensure_ascii=False))
    archive.writestr("content.xml", content_xml)
    archive.writestr("metadata.json", json.dumps(metadata))
    archive.writestr("manifest.json", json.dumps(manifest))

assert len(sheets) == 1
print(f"Created {OUTPUT.name}: {len(sheets)} sheets")
