# Stocklog — 미국주식 분석 & 매매일지

## 배포 방법 (10분)

### 1. Supabase DB 테이블 만들기

1. [supabase.com](https://supabase.com) 대시보드 접속
2. 왼쪽 메뉴 → **SQL Editor**
3. `supabase-setup.sql` 파일 내용 전체 복사해서 붙여넣기
4. **Run** 클릭

### 2. GitHub에 올리기

```bash
# 이 폴더에서 실행
git init
git add .
git commit -m "first commit"
# GitHub에서 새 repository 만들고
git remote add origin https://github.com/YOUR_NAME/stocklog.git
git push -u origin main
```

### 3. Vercel 배포


1. [vercel.com](https://vercel.com) → **Add New Project**
2. GitHub repository 선택
3. **Environment Variables** 에 아래 두 개 추가:
   - `NEXT_PUBLIC_SUPABASE_URL` = Supabase Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = Supabase anon key
4. **Deploy** 클릭

5분 후 `your-project.vercel.app` URL로 접속 가능!

## 기능

- 🔍 AI 종목 추천 (조건 기반, Claude.ai 연동)
- 📊 7가지 기준 종목 분석 체크리스트
- 📝 매수/매도 일지 기록 (Supabase 저장)
- 💼 포트폴리오 현황 & 수익률 추적
- 🔄 분기 리밸런싱 체크리스트
