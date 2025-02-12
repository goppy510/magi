import os
import logging
import random
import json
import asyncio
import inspect
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

import openai
from google import genai

from comment_analyzer import CommentAnalyzer
from channel_subscriber_popular_analyzer import ChannelPopularityAnalyzer


# ===============================
# 環境変数やモデル名
# ===============================
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

GPT_MODEL_NAME = "chatgpt-4o-latest"
GEMINI_MODEL_NAME = "gemini-2.0-flash"

openai.api_key = OPENAI_API_KEY

client = None
try:
    client = genai.Client(api_key=GEMINI_API_KEY)
except Exception as e:
    print(f"Geminiの初期化エラー: {e}")

app = FastAPI()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("websocket_server")


# ===============================
# GPT 呼び出し関数
# ===============================
def call_chatgpt(prompt: str) -> str:
    try:
        response = openai.chat.completions.create(
            model=GPT_MODEL_NAME,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
        )
        return response.choices[0].message.content if response.choices else "エラー: GPT からのレスポンスがありません"
    except Exception as e:
        return f"ChatGPTエラー: {e}"


# ===============================
# Gemini 呼び出し関数
# ===============================
def call_gemini(prompt: str) -> str:
    if not client:
        return "Gemini の Client が初期化されていません"
    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL_NAME,
            contents=prompt,
        )
        return response.text if response.text else "エラー: Gemini からのレスポンスがありません"
    except Exception as e:
        return f"Geminiエラー: {e}"


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    - 両者が最低3回は話す
    - 各モデル最大10回 (合計20発言) になったら強制終了
    - それまでに"合意" or "同意" が出ても、両者とも3回以上話していなければ続行
    - 追加データがある場合は、プロンプトに埋め込んで AI に渡す
    """
    await websocket.accept()
    logger.info("クライアントが接続されました")

    try:
        conversation_history = []  # (sender, text)
        input_data = await websocket.receive_text()
        input_json = json.loads(input_data)

        topic = input_json.get("topic", "")
        analysis_type = input_json.get("analysisType", "none")
        video_id = input_json.get("videoId")
        channel_id = input_json.get("channelId")

        conversation_history.append(("User", topic))

        # **分析データの取得**
        analysis_data = load_data_for_analysis(analysis_type, video_id, channel_id)

        # **プロンプト作成**
        if analysis_type == "comment_analysis":
            prompt = __generate_comment_analysis_prompt(topic, analysis_data)
        else:
            prompt = topic  # そのまま議題を使用

        # **(1) GPT / Gemini 初期見解**
        try:
            gpt_first = call_chatgpt(
                f"'{prompt}' に対して建設的な初見を述べてください。補足や提案を含め、1000文字以内で。"
            )
        except Exception as e:
            await websocket.send_text(json.dumps({"sender": "system", "text": f"ChatGPTエラー: {e}"}))
            return

        try:
            gemini_first = call_gemini(
                f"'{prompt}' に対して建設的な初見を述べてください。補足や提案を含め、1000文字以内で。"
            )
        except Exception as e:
            await websocket.send_text(json.dumps({"sender": "system", "text": f"Geminiエラー: {e}"}))
            return

        # **初期発言を送信 & 履歴保存**
        await websocket.send_text(json.dumps({"sender": f"GPT({GPT_MODEL_NAME})", "text": gpt_first}))
        conversation_history.append((f"GPT({GPT_MODEL_NAME})", gpt_first))

        await websocket.send_text(json.dumps({"sender": f"Gemini({GEMINI_MODEL_NAME})", "text": gemini_first}))
        conversation_history.append((f"Gemini({GEMINI_MODEL_NAME})", gemini_first))

        # **(2) 議論の進行**
        roles = [f"GPT({GPT_MODEL_NAME})", f"Gemini({GEMINI_MODEL_NAME})"]
        random.shuffle(roles)
        attacker, defender = roles

        gpt_count = 1
        gem_count = 1
        max_comments = 10  # 各AIの最大発言回数

        while gpt_count < 10 and gem_count < 10:
            attacker_prompt = f"""
            あなたは {attacker} として議論に参加しています。
            相手({defender})の意見:
            {conversation_history[-1][1]}

            攻撃的ではなく建設的に反論や補足を行い、
            合意が得られそうなら合意を示してください。
            疑問点や矛盾点があれば質問し、回答を求めてください。
            (最終的に合意や結論が得られるように努めてください。)
            1000文字以内でお願いします。
            あなたの発言回数は {gpt_count if "GPT" in attacker else gem_count} 回目です。
            """

            try:
                if "GPT" in attacker:
                    attacker_resp = call_chatgpt(attacker_prompt)
                    gpt_count += 1
                else:
                    attacker_resp = call_gemini(attacker_prompt)
                    gem_count += 1
            except Exception as e:
                await websocket.send_text(json.dumps({"sender": "system", "text": f"{attacker}エラー: {e}"}))
                break

            conversation_history.append((attacker, attacker_resp))
            await websocket.send_text(json.dumps({"sender": attacker, "text": attacker_resp}))

            # **最低3回話すまでは合意判定を無視**
            if gpt_count >= 3 and gem_count >= 3:
                if "合意" in attacker_resp or "同意" in attacker_resp:
                    break

            # 交代
            attacker, defender = defender, attacker

        # **(3) まとめ**
        conversation_text = "\n\n".join([f"{speaker}: {text}" for speaker, text in conversation_history])

        if analysis_type == "none":
            summary_prompt = f"""
            これまでの議論:
            {conversation_text}

            以下のフォーマットでまとめてください：
            1. 【議題】
            2. 【主張と意見】
            3. 【合意点 / 食い違い点】
            4. 【結論と今後の方向性】

            ただし、マークダウンで出力できるようにフォーマットをしてください。
            """
            try:
                summary = call_chatgpt(summary_prompt)
                await websocket.send_text(json.dumps({"sender": "GPTまとめ", "text": summary}))
            except Exception as e:
                await websocket.send_text(json.dumps({"sender": "system", "text": f"まとめエラー: {e}"}))

        if analysis_type == "comment_analysis":
            summary_prompt = f"""
            これまでの議論の内容、および提供したデータから、最終的な当該動画のコメント分析結果を詳細にまとめてください。
            客先に提出する内容なので、このレポートを見て動画の振り返りや今後の企画ができるような内容に仕上げてください。
            コメントから見える動画内容への評価や、視聴者の反応についても含めてください。

            議論データ:
            {conversation_text}

            分析データ:
            {analysis_data}

            また、各生成AIの解釈や認識に違いがあった場合は、別途項目を作り、それぞれ、どのような違いがあったのかをまとめてください。
            ただし、マークダウンで出力できるようにフォーマットをしてください。
            """
            try:
                summary = call_chatgpt(summary_prompt)
                await websocket.send_text(json.dumps({"sender": "GPTまとめ", "text": summary}))
            except Exception as e:
                await websocket.send_text(json.dumps({"sender": "system", "text": f"まとめエラー: {e}"}))

    except WebSocketDisconnect:
        logger.warning("クライアントが切断されました")
    except Exception as e:
        logger.error(f"サーバーエラー: {e}")
    finally:
        await websocket.close()
        logger.info("WebSocketコネクション終了")


def load_data_for_analysis(analysis_type: str, video_id: str = None, channel_id: str = None):
    if analysis_type == "comment_analysis" and video_id:
        data = CommentAnalyzer(video_id).create_data()
        print(f"data: {data}")
        return data

    if analysis_type == "channel_subscriber_popular_channel" and channel_id:
        return aurora.fetch_popular_channels(channel_id)

    return {"message": "データなし"}

def __generate_comment_analysis_prompt(user_input: str, analysis_data: dict) -> str:
    """
    ユーザーの議題と `load_data_for_analysis` から取得したデータを組み合わせてプロンプトを生成
    """
    prompt = f"議題: '{user_input}'\n\n"

    prompt += "この動画に関する登校日から7日間のコメントデータがあります。\n"
    prompt += f"動画データ: {analysis_data['video_data']}\n"
    prompt += f"コメントデータ:\n{analysis_data['comment_data']}...\n\n"
    prompt += f"動画の10日間の統計データ: {analysis_data['video_stats']}\n"
    prompt += f"チャンネルデータ: {analysis_data['channel_data']}\n"
    prompt += f"チャンネルの視聴者層の年齢分布予測データ: {analysis_data['age_prediction']}\n"
    prompt += f"チャンネルの視聴者層の性別分布予測データ: {analysis_data['gender_prediction']}\n"
    prompt += "これらのデータから、この動画の分析を詳細に報告してください。マークダウンで出力できるようにフォーマットをしてください。"
    prompt += "また、動画投稿日前後に起きた日本国内での出来事などと、可能であれば関連付けて分析してください。"

    return prompt
