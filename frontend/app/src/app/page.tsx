"use client";

import { useEffect, useState, useRef } from "react";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { marked } from "marked";

interface Message {
  sender: string; // 例: "User" | "GPT(3.5)" | "Gemini(2.0)" | "GPTまとめ"
  text: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [topic, setTopic] = useState("");
  const [analysisType, setAnalysisType] = useState("none");
  const [videoId, setVideoId] = useState("");
  const [channelId, setChannelId] = useState("");
  const socketRef = useRef<WebSocket | null>(null);

  const connectWebSocket = () => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      return; // すでに接続されている場合は何もしない
    }

    console.log("WebSocket 再接続を試みます...");
    const ws = new WebSocket("ws://localhost:8001/ws");
    socketRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket 接続成功");
      setIsConnected(true);
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as Message;
        setMessages((prev) => [...prev, data]);
        setLoading(false); // ✅ レスポンスが返ってきたらローディング終了
      } catch (error) {
        console.error("メッセージのパースエラー:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket エラー:", error);
    };

    ws.onclose = () => {
      console.log("WebSocket切断 - 再接続待機中");
      setIsConnected(false);
      setLoading(false);
    };
  };

  /** ✅ 初回レンダリング時に WebSocket 接続 **/
  useEffect(() => {
    connectWebSocket();

    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

  /** ✅ 議題欄がアクティブになったら WebSocket 再接続 **/
  const handleFocus = () => {
    if (!isConnected) {
      console.log("入力欄がフォーカスされたので WebSocket を再接続します");
      connectWebSocket();
    }
  };

  const sendMessage = () => {
    if (socketRef.current && isConnected) {
      const payload = {
        topic: topic,
        analysisType: analysisType !== "none" ? analysisType : undefined,
        videoId: analysisType === "comment_analysis" ? videoId : undefined,
        channelId: analysisType === "channel_subscriber_popular_channel" ? channelId : undefined,
      };

      console.log("送信データ:", payload);
      setMessages((prev) => [...prev, { sender: "User", text: topic }]);
      socketRef.current.send(JSON.stringify(payload));
      setTopic("");
      setLoading(true);
    } else {
      console.warn("WebSocket未接続です");
    }
  };

// ✅ テキストの自動改行処理
const wrapText = (text: string, font: any, fontSize: number, maxWidth: number) => {
  const lines: string[] = [];
  let currentLine = "";

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const width = font.widthOfTextAtSize(currentLine + char, fontSize);

    if (width > maxWidth) {
      lines.push(currentLine);
      currentLine = char;
    } else {
      currentLine += char;
    }
  }

  lines.push(currentLine);
  return lines;
};

const generatePDF = async () => {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  // ✅ 可変フォントを読み込む
  const fontBytes = await fetch("/fonts/NotoSansJP-VariableFont_wght.ttf").then((res) => res.arrayBuffer());
  const notoSansJP = await pdfDoc.embedFont(fontBytes);

  let page = pdfDoc.addPage([600, 800]);
  const { width, height } = page.getSize();
  let yOffset = height - 50;

  const lineHeight = 16;
  const marginX = 50;
  const maxWidth = width - marginX * 2;

  // ✅ ヘッダーを描画
  page.drawText("議論記録", {
    x: marginX,
    y: yOffset,
    size: 20,
    font: notoSansJP,
    color: rgb(0, 0, 0),
  });

  yOffset -= 30;

  // ✅ マークダウンをHTMLに変換 → テキスト化
  const markdownText = messages
    .filter((msg) => msg.sender === "GPTまとめ")
    .map((msg) => msg.text)
    .join("\n\n");

  const mdHtml = marked.parse(markdownText, { renderer: new marked.Renderer() }) as string;

  // ✅ 不要なHTMLタグを削除（<b>, <strong>, <i>, <em> など）
  const plainText = mdHtml
    .replace(/<\/?(b|strong|i|em|pre|code)[^>]*>/g, "")  // <b>, <i>, <pre>, <code> など削除
    .replace(/\*\*(.*?)\*\*/g, "$1")  // **太字** → 太字
    .replace(/__(.*?)__/g, "$1")      // __太字__ → 太字
    .replace(/`([^`]*)`/g, "$1")      // `インラインコード` → インラインコード
    .replace(/<\/?[^>]+(>|$)/g, "");  // その他のHTMLタグを削除

  const paragraphs = plainText.split("\n");

  paragraphs.forEach((paragraph: string) => {
    const wrappedLines = wrapText(paragraph, notoSansJP, 12, maxWidth);

    wrappedLines.forEach((line) => {
      page.drawText(line, { x: marginX, y: yOffset, size: 12, font: notoSansJP, color: rgb(0, 0, 0) });
      yOffset -= lineHeight;

      if (yOffset < 50) {
        // ✅ ページング処理
        page = pdfDoc.addPage([600, 800]);
        yOffset = height - 30;
      }
    });

    yOffset -= 5; // 段落間のスペース
  });

  const pdfBytes = await pdfDoc.save();

  // ✅ PDF ダウンロード処理
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "議論記録.pdf";
  link.click();
};

  /** ✅ チャット欄をクエリに変換する **/
  const clearChat = () => {
    setMessages([]);
  };

  // メッセージ描画
  const renderMessage = (msg: Message, index: number) => {
    const sender = msg.sender;

    let alignment = "justify-start";
    let bgColor = "bg-blue-200";

    if (sender.includes("Gemini")) {
      alignment = "justify-end";
      bgColor = "bg-green-200";
    } else if (sender === "User") {
      alignment = "justify-center";
      bgColor = "bg-gray-300";
    }

    return (
      <div key={index} className={`flex mb-2 ${alignment}`}>
        <div className={`p-2 rounded-lg max-w-xs ${bgColor}`}>
          <strong>{sender}:</strong> {msg.text}
        </div>
      </div>
    );
  };

  return (
    <div className="h-screen flex flex-col p-4">
      <h1 className="text-2xl font-bold mb-4">MAG(K)I波MARI イラストりあす</h1>

      {/* メッセージ入力 */}
      <div className="mt-4 flex space-x-2">
        <input
          className="border p-2 flex-1"
          type="text"
          placeholder="議題やメッセージを入力..."
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onFocus={handleFocus}
        />
        <button
          onClick={sendMessage}
          className="bg-blue-500 text-white px-4 py-2 rounded disabled:bg-gray-400"
          disabled={!isConnected || !topic.trim()}
        >
          送信
        </button>

        <button
          onClick={clearChat}
          className="bg-purple-500 text-white px-4 py-2 rounded mt-2"
          disabled={messages.length === 0}
        >
          チャット欄をクリア
        </button>
      </div>

      {/* 分析タイプ選択 */}
      <div className="mb-4">
        <p className="font-bold">分析タイプを選択:</p>
        <label className="mr-4">
          <input type="radio" value="none" checked={analysisType === "none"} onChange={() => setAnalysisType("none")} />
          分析なし
        </label>
        <label className="mr-4">
          <input type="radio" value="comment_analysis" checked={analysisType === "comment_analysis"} onChange={() => setAnalysisType("comment_analysis")} />
          コメント分析
        </label>
        <label>
          <input type="radio" value="channel_subscriber_popular_channel" checked={analysisType === "channel_subscriber_popular_channel"} onChange={() => setAnalysisType("channel_subscriber_popular_channel")} />
          視聴者人気のチャンネル分析
        </label>
      </div>

      {analysisType === "comment_analysis" && (
        <div className="mb-4">
          <p className="font-bold">動画IDを入力:</p>
          <input className="border p-2 w-full" type="text" placeholder="動画IDを入力..." value={videoId} onChange={(e) => setVideoId(e.target.value)} />
        </div>
      )}

      {analysisType === "channel_subscriber_popular_channel" && (
        <div className="mb-4">
          <p className="font-bold">チャンネルIDを入力:</p>
          <input className="border p-2 w-full" type="text" placeholder="UC..." value={channelId} onChange={(e) => setChannelId(e.target.value)} />
        </div>
      )}

      {/* メッセージ表示 */}
      <div className="flex-1 bg-gray-100 p-4 rounded overflow-y-auto">{messages.map((msg, idx) => renderMessage(msg, idx))}</div>

      {/* GPTまとめが最後に来たら PDF 出力ボタンを表示 */}
      {messages.length > 0 && messages[messages.length - 1].sender === "GPTまとめ" && (
        <button onClick={generatePDF} className="bg-red-500 text-white px-4 py-2 rounded mt-2">
          PDFで出力
        </button>
      )}

      <p className="mt-2">Status: {isConnected ? "Connected" : "Disconnected"}</p>
    </div>
  );
}
