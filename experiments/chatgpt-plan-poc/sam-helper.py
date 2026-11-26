"""
本機切割工具：用 SAM 2.1（Meta Segment Anything 2.1，免費、在自己的 Mac 上跑）依零件框切出配件的精準範圍。

用法：
  python sam-helper.py --check                  確認套件和模型都在（第一次會下載模型）
  python sam-helper.py <圖片> <prompts.json> <輸出資料夾>

prompts.json：
  { "boxes": { "hat": [x0, y0, x1, y1], ... },   # 像素座標
    "negative": [[x, y], ...] }                  # 「不是這裡」的點（例如臉的中央），可省略

每個配件輸出一張黑白 PNG（白＝配件），最後一行印出 JSON：
  {"ok": true, "device": "mps", "masks": {"hat": {"file": "...", "score": 0.97}}}
失敗時：{"ok": false, "error": "..."}
"""
import json
import os
import sys

MODEL_ID = os.environ.get("SAM_MODEL_ID", "facebook/sam2.1-hiera-large")


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def load():
    import torch
    from transformers import Sam2Model, Sam2Processor

    if torch.backends.mps.is_available():
        device = "mps"
    elif torch.cuda.is_available():
        device = "cuda"
    else:
        device = "cpu"
    model = Sam2Model.from_pretrained(MODEL_ID).to(device)
    model.eval()
    processor = Sam2Processor.from_pretrained(MODEL_ID)
    return torch, model, processor, device


def segment(image_path, prompts_path, out_dir):
    from PIL import Image

    torch, model, processor, device = load()
    with open(prompts_path, encoding="utf-8") as file:
        prompts = json.load(file)
    image = Image.open(image_path).convert("RGB")
    negative = [[float(x), float(y)] for x, y in prompts.get("negative", [])][:8]
    os.makedirs(out_dir, exist_ok=True)

    embeddings = None
    original_sizes = None
    results = {}
    for name, box in prompts.get("boxes", {}).items():
        box = [float(v) for v in box]
        kwargs = {"input_boxes": [[box]], "return_tensors": "pt"}
        if negative:
            kwargs["input_points"] = [[negative]]
            kwargs["input_labels"] = [[[0] * len(negative)]]
        if embeddings is None:
            inputs = processor(images=image, **kwargs).to(device)
            original_sizes = inputs["original_sizes"]
        else:
            inputs = processor(original_sizes=original_sizes, **kwargs).to(device)
        with torch.no_grad():
            if embeddings is None:
                outputs = model(**inputs, multimask_output=True)
                embeddings = outputs.image_embeddings  # 同一張圖只算一次
            else:
                outputs = model(**inputs, image_embeddings=embeddings, multimask_output=True)
        masks = processor.post_process_masks(outputs.pred_masks.cpu(), original_sizes.cpu())[0]
        scores = outputs.iou_scores.float().cpu()[0, 0]
        best = int(torch.argmax(scores))
        mask = (masks[0, best].numpy() > 0).astype("uint8") * 255
        path = os.path.join(out_dir, f"{name}.png")
        Image.fromarray(mask, mode="L").save(path)
        results[name] = {"file": path, "score": round(float(scores[best]), 4)}
    emit({"ok": True, "device": device, "masks": results})


def main():
    try:
        if "--check" in sys.argv:
            _, _, _, device = load()
            emit({"ok": True, "device": device, "model": MODEL_ID})
            return
        if len(sys.argv) < 4:
            emit({"ok": False, "error": "usage: sam-helper.py <image> <prompts.json> <out_dir>"})
            return
        segment(sys.argv[1], sys.argv[2], sys.argv[3])
    except Exception as error:  # 回報給 App，不要整個當掉
        emit({"ok": False, "error": f"{type(error).__name__}: {error}"[:600]})


if __name__ == "__main__":
    main()
