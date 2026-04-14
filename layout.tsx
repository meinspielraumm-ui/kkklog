import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Stocklog — 미국주식 분석 & 매매일지',
  description: '7가지 기준으로 종목을 분석하고, 매매일지와 포트폴리오를 관리하세요.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}
