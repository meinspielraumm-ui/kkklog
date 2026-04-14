-- Supabase 대시보드 > SQL Editor에서 실행하세요

-- 거래 일지 테이블
create table if not exists trades (
  id bigserial primary key,
  created_at timestamptz default now(),
  user_id text default 'local',
  ticker text not null,
  type text not null check (type in ('BUY','SELL')),
  date date not null,
  price numeric not null,
  qty numeric not null,
  score text,
  reason text,
  memo text
);

-- 현재가 테이블
create table if not exists prices (
  id bigserial primary key,
  user_id text default 'local',
  ticker text not null,
  current_price numeric not null,
  updated_at timestamptz default now(),
  unique(ticker)
);

-- RLS 비활성화 (개인용 — 나중에 로그인 추가 시 켜기)
alter table trades disable row level security;
alter table prices disable row level security;
