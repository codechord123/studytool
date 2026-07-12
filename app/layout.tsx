import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "임선생의 도형학습",
  description: "초등 5·6학년 도형(둘레·넓이·각도·입체) 수업용 인터랙티브 학습 도구",
  keywords: ["초등 수학", "도형", "넓이", "둘레", "입체도형", "전개도", "수업 도구", "에듀테크"],
  openGraph: {
    title: "임선생의 도형학습",
    description: "직접 자르고 붙이고 돌리며 넓이 공식을 발견하는 초등 5·6학년 도형 학습 도구",
    type: "website",
    locale: "ko_KR",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#f8fafc",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
