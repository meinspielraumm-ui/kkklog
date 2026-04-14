import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co'
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

export type Trade = {
  id: number
  created_at: string
  user_id: string
  ticker: string
  type: 'BUY' | 'SELL'
  date: string
  price: number
  qty: number
  score: string
  reason: string
  memo: string
}

export type Analysis = {
  id: number
  created_at: string
  user_id: string
  ticker: string
  score: number
  verdict: string
  summary: string
  data_note: string
  pass_c1: boolean
  pass_c2: boolean
  pass_c3: boolean
  pass_c4: boolean
  pass_c5: boolean
  pass_c6: boolean
  pass_c7: boolean
  raw_data: Record<string, unknown>
}

export type Price = {
  id: number
  user_id: string
  ticker: string
  current_price: number
  updated_at: string
}
