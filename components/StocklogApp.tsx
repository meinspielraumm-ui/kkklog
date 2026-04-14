'use client'
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import type { Trade } from '../lib/supabase'

// ── TYPES ────────────────────────────────────────────────
type CritState = { status: 'pass' | 'fail' | 'neutral'; _ai?: boolean; [key: string]: unknown }
type CritMap = Record<string, CritState>
type PriceMap = Record<string, number>
type RbMap = Record<string, boolean>

type RecCard = {
  ticker: string; name: string; sector: string; type: string
  score: number; verdict: string; pe_ratio: number | null; peg_ratio: number | null
  div_yield: number | null; revenue_growth: number; analyst_buy_pct: number
  checks: Record<string, boolean>; summary: string; risk: string
}

// ── CRITERIA DEF ─────────────────────────────────────────
const CR = [
  { id:'c1', g:'q', n:'#01', t:'흑자 기업 확인', d:'최근 TTM 순이익(Net Income) 흑자 여부.',
    f:[{ id:'c1a', l:'순이익 TTM ($M)', tp:'number', ph:'ex. 94.7', ak:'net_income_ttm' }] },
  { id:'c2', g:'q', n:'#02', t:'5년 매출 성장 안정성', d:'Revenue Growth 5년 연속 증가. 역성장 2회 이하.',
    f:[{ id:'c2a', l:'5년 연평균 성장률 %', tp:'number', ph:'ex. 12.5', ak:'revenue_cagr_5y' }] },
  { id:'c3', g:'q', n:'#03', t:'애널리스트 의견', d:'매수 비중 > 매도 비중. 매도 급증 시 이유 파악 필수.',
    f:[{ id:'c3a', l:'매수 비중 %', tp:'number', ph:'ex. 72', ak:'analyst_buy_pct' }, { id:'c3b', l:'매도 비중 %', tp:'number', ph:'ex. 8', ak:'analyst_sell_pct' }] },
  { id:'c4', g:'q', n:'#04', t:'예상 실적 성장', d:'향후 2년 예상 EPS·매출 성장률 플러스.',
    f:[{ id:'c4a', l:'예상 EPS 성장률 %', tp:'number', ph:'ex. 18', ak:'eps_growth_fwd' }] },
  { id:'c5', g:'v', n:'#05', t:'PER 수준', d:'현재 PER vs 5년 평균. PEG < 1이면 저평가.',
    f:[{ id:'c5a', l:'현재 PER', tp:'number', ph:'ex. 28', ak:'pe_ratio' }, { id:'c5b', l:'PEG', tp:'number', ph:'ex. 0.8', ak:'peg_ratio' }] },
  { id:'c6', g:'v', n:'#06', t:'모닝스타 적정주가', d:'별 4~5개 = 저평가 구간.',
    f:[{ id:'c6a', l:'별점 1–5', tp:'number', ph:'1~5', ak:'morningstar_stars' }] },
  { id:'c7', g:'t', n:'#07', t:'매수 타이밍', d:'배당주: 배당수익률↑ + 배당성향 ≤50%. 성장주: PEG<1 + 악재 없는 주가 하락.',
    f:[{ id:'c7a', l:'유형', tp:'select', opts:['—','배당주','성장주'], ak:'stock_type' }, { id:'c7b', l:'배당수익률 / PEG', tp:'number', ph:'ex. 2.4', ak:'div_yield_or_peg' }] },
]

const RBI = {
  a:[{ id:'r1',m:'institutional.fidelity.com 접속',d:'현재 경기 사이클 위치 확인' },
     { id:'r2',m:'사이클 방향성 판단',d:'확장기 → 정보기술·금융↑ | 둔화기 → 헬스케어·필수소비재↑' },
     { id:'r3',m:'포트폴리오 섹터 구성 대조',d:'보유 ETF·주식 섹터가 현재 사이클에 맞는지 확인' }],
  b:[{ id:'r4',m:'섹터별 1년 vs 5·10년 수익률 비교',d:'단기 과열 섹터 비중 축소' },
     { id:'r5',m:'과열 섹터 식별',d:'통신·금융·임의소비재 단기 급등 여부' },
     { id:'r6',m:'소외 섹터 발굴',d:'헬스케어·필수소비재 저평가 여부 확인' }],
  c:[{ id:'r7',m:'FED Watch 금리 전망 확인',d:'인베스팅닷컴 FED 금리 모니터 툴' },
     { id:'r8',m:'점도표 최신판 확인',d:'3·6·9·12월 FOMC 후 발표' },
     { id:'r9',m:'금리 방향에 따라 비중 조정',d:'인하 예상 → 성장주↑ | 인상 예상 → 가치주↑' }],
  d:[{ id:'r10',m:'분기 실적 발표 체크',d:'매출 전년 대비 감소 → 보유량 ¼ 매도' },
     { id:'r11',m:'투자 아이디어 훼손 점검',d:'경제적 해자 변화 여부' },
     { id:'r12',m:'비중 조정 (5~10% 룰)',d:'거치식: 5~10% 단위로만 | 적립식: 다음 매수 ETF 변경' }],
}

// ── UTILS ────────────────────────────────────────────────
function tryParseJSON(raw: string) {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch {
    try { return JSON.parse(m[0].replace(/[\x00-\x1F\x7F]/g, ' ')) } catch { return null }
  }
}

export default function StocklogApp() {
  const [view, setView] = useState<'rec'|'analysis'|'journal'|'portfolio'|'rebalance'>('rec')
  const [trades, setTrades] = useState<Trade[]>([])
  const [prices, setPrices] = useState<PriceMap>({})
  const [crit, setCrit] = useState<CritMap>({})
  const [rb, setRb] = useState<RbMap>({})
  const [loading, setLoading] = useState(true)

  // ANALYSIS state
  const [ticker, setTicker] = useState('')
  const [analysisStatus, setAnalysisStatus] = useState({ type: '', title: '티커를 입력하고 AI에게 요청하세요', sub: '채팅창에 분석 요청이 전송돼요' })
  const [apaste, setApaste] = useState('')
  const [apHint, setApHint] = useState('JSON을 붙여넣으면 자동으로 인식해요')

  // JOURNAL state
  const [tradeType, setTradeType] = useState<'BUY'|'SELL'>('BUY')
  const [showTradeForm, setShowTradeForm] = useState(false)
  const [jForm, setJForm] = useState({ ticker:'', date: new Date().toISOString().split('T')[0], price:'', qty:'', score:'', reason:'', memo:'' })

  // REC state
  const [recCards, setRecCards] = useState<RecCard[]>([])
  const [rpaste, setRpaste] = useState('')
  const [rpHint, setRpHint] = useState('JSON을 붙여넣으면 카드로 렌더링돼요')
  const [recStatus, setRecStatus] = useState({ type:'', title:'조건을 설정하고 AI에게 추천을 요청하세요', sub:'필터를 고른 후 "AI에게 추천 요청" 클릭' })
  const [filters, setFilters] = useState({ style:'안정추구형', type:'둘 다', sectors:['전체'], cap:'전체', cycle:'현재 사이클 자동 반영', score:'4개 이상 통과' })

  // PRICE UPDATE
  const [priceInput, setPriceInput] = useState({ ticker:'', val:'' })

  // Load from Supabase
  const loadData = useCallback(async () => {
    const { data: tradesData } = await supabase.from('trades').select('*').order('created_at', { ascending: false })
    const { data: pricesData } = await supabase.from('prices').select('*')
    if (tradesData) setTrades(tradesData)
    if (pricesData) {
      const pm: PriceMap = {}
      pricesData.forEach((p: { ticker: string; current_price: number }) => { pm[p.ticker] = p.current_price })
      setPrices(pm)
    }
    const saved = localStorage.getItem('sl_crit')
    const savedRb = localStorage.getItem('sl_rb')
    if (saved) setCrit(JSON.parse(saved))
    if (savedRb) setRb(JSON.parse(savedRb))
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const saveCrit = (newCrit: CritMap) => {
    setCrit(newCrit)
    localStorage.setItem('sl_crit', JSON.stringify(newCrit))
  }
  const saveRb = (newRb: RbMap) => {
    setRb(newRb)
    localStorage.setItem('sl_rb', JSON.stringify(newRb))
  }

  // ── SCORE ──────────────────────────────────────────────
  const calcScore = () => {
    const pass = CR.filter(c => (crit[c.id]?.status) === 'pass').length
    const allN = CR.every(c => !crit[c.id]?.status || crit[c.id].status === 'neutral')
    return { pass, allN }
  }
  const { pass: scorePass, allN: scoreAllN } = calcScore()
  const verdict = scoreAllN ? 'none' : scorePass >= 6 ? 'buy' : scorePass >= 4 ? 'watch' : 'pass'

  // ── ANALYSIS ───────────────────────────────────────────
  const reqAnalysis = () => {
    if (!ticker) return
    setAnalysisStatus({ type: '', title: `${ticker} 분석 요청을 채팅창에 전송했어요`, sub: 'AI 답변 JSON을 아래에 붙여넣으세요' })
    const prompt = `[STOCKLOG 분석 요청]\nticker: ${ticker}\n\n아래 JSON 형식으로만 답변해줘. 마크다운, 설명 없이 JSON 블록만.\n\`\`\`json\n{"ticker":"${ticker}","net_income_ttm":0,"revenue_cagr_5y":0,"analyst_buy_pct":0,"analyst_sell_pct":0,"eps_growth_fwd":0,"pe_ratio":0,"peg_ratio":null,"morningstar_stars":null,"stock_type":"성장주","div_yield_or_peg":0,"pass_c1":true,"pass_c2":true,"pass_c3":true,"pass_c4":true,"pass_c5":false,"pass_c6":false,"pass_c7":false,"summary":"요약","data_note":"2026년 4월 기준"}\n\`\`\``
    navigator.clipboard?.writeText(prompt)
    alert(`분석 요청이 클립보드에 복사됐어요!\nClaude.ai 채팅창에 붙여넣기(Ctrl+V) 하면 돼요.`)
  }

  const applyAnalysis = () => {
    const p = tryParseJSON(apaste)
    if (!p) { alert('JSON 형식이 올바르지 않아요'); return }
    const newCrit = { ...crit }
    CR.forEach(c => {
      if (!newCrit[c.id]) newCrit[c.id] = { status: 'neutral' }
      c.f.forEach(f => {
        if (!f.ak) return
        const v = p[f.ak]
        if (v !== null && v !== undefined) newCrit[c.id][f.id] = String(v)
      })
      const pk = 'pass_' + c.id
      if (p[pk] !== undefined) {
        newCrit[c.id].status = p[pk] ? 'pass' : 'fail'
        newCrit[c.id]._ai = true
      }
    })
    saveCrit(newCrit)
    setAnalysisStatus({ type: 'ok', title: `${p.ticker || ticker} 분석 완료 — ${p.data_note || ''}`, sub: p.summary || '' })
    setApaste('')
    setApHint('JSON을 붙여넣으면 자동으로 인식해요')
  }

  const onApaste = (v: string) => {
    setApaste(v)
    const p = tryParseJSON(v)
    setApHint(p?.ticker ? `✓ ${p.ticker} 인식됨 — "데이터 적용" 클릭` : 'JSON 형식을 확인해주세요')
  }

  const toggleCrit = (id: string) => {
    const cur = crit[id]?.status || 'neutral'
    const next = cur === 'neutral' ? 'pass' : cur === 'pass' ? 'fail' : 'neutral'
    saveCrit({ ...crit, [id]: { ...crit[id], status: next, _ai: false } })
  }

  // ── JOURNAL ────────────────────────────────────────────
  const saveTrade = async () => {
    const { ticker: t, date, price, qty } = jForm
    if (!t || !date || !price || !qty) { alert('필수 항목을 입력하세요'); return }
    const { error } = await supabase.from('trades').insert({
      ticker: t.toUpperCase(), type: tradeType, date,
      price: parseFloat(price), qty: parseFloat(qty),
      score: jForm.score, reason: jForm.reason, memo: jForm.memo,
      user_id: 'local'
    })
    if (!error) {
      setShowTradeForm(false)
      setJForm({ ticker:'', date: new Date().toISOString().split('T')[0], price:'', qty:'', score:'', reason:'', memo:'' })
      loadData()
    }
  }

  const deleteTrade = async (id: number) => {
    await supabase.from('trades').delete().eq('id', id)
    setTrades(prev => prev.filter(t => t.id !== id))
  }

  // ── PORTFOLIO ──────────────────────────────────────────
  const calcHoldings = () => {
    const m: Record<string, { qty: number; cost: number }> = {}
    trades.forEach(t => {
      if (!m[t.ticker]) m[t.ticker] = { qty: 0, cost: 0 }
      if (t.type === 'BUY') { m[t.ticker].cost += t.price * t.qty; m[t.ticker].qty += t.qty }
      else { const avg = m[t.ticker].qty > 0 ? m[t.ticker].cost / m[t.ticker].qty : 0; m[t.ticker].cost -= avg * t.qty; m[t.ticker].qty -= t.qty }
    })
    return Object.entries(m).filter(([, v]) => v.qty > 0.0001).map(([tk, v]) => {
      const avg = v.qty > 0 ? v.cost / v.qty : 0
      const cp = prices[tk] || null
      const mv = cp ? cp * v.qty : null
      const pnl = cp ? (cp - avg) * v.qty : null
      const pct = cp && avg > 0 ? ((cp - avg) / avg) * 100 : null
      return { ticker: tk, qty: v.qty, avg, cp, mv, pnl, pct }
    })
  }
  const holdings = calcHoldings()
  const totalCost = holdings.reduce((s, h) => s + h.avg * h.qty, 0)
  const totalMv = holdings.filter(h => h.mv).reduce((s, h) => s + h.mv!, 0)
  const totalPnl = holdings.filter(h => h.pnl !== null).reduce((s, h) => s + h.pnl!, 0)
  const totalRet = totalCost > 0 && totalMv > 0 ? ((totalMv - totalCost) / totalCost) * 100 : null
  const totalWeight = totalMv > 0 ? totalMv : totalCost

  const updatePrice = async (tk: string, val: string) => {
    const n = parseFloat(val)
    if (isNaN(n) || n <= 0 || !tk) return
    await supabase.from('prices').upsert({ ticker: tk, current_price: n, user_id: 'local', updated_at: new Date().toISOString() }, { onConflict: 'ticker' })
    setPrices(prev => ({ ...prev, [tk]: n }))
  }

  // ── RECOMMEND ──────────────────────────────────────────
  const reqRec = () => {
    const sectorTxt = filters.sectors.includes('전체') ? '전체 섹터' : filters.sectors.join(', ')
    const prompt = `[STOCKLOG 종목 추천 요청]\n\n투자 조건:\n- 투자 성향: ${filters.style}\n- 종목 유형: ${filters.type}\n- 선호 섹터: ${sectorTxt}\n- 시가총액: ${filters.cap}\n- 경기 사이클 대응: ${filters.cycle}\n- 최소 기준: ${filters.score}\n\n아래 7가지 기준으로 미국 주식/ETF를 5개 추천해줘.\n기준: ①흑자기업 ②5년매출성장 ③애널리스트매수우세 ④예상실적성장 ⑤PER적정/PEG<1 ⑥모닝스타저평가 ⑦매수타이밍\n\n\`\`\`json\n{"generated_at":"날짜","conditions_summary":"조건 한줄 요약","recommendations":[{"ticker":"티커","name":"기업명","sector":"섹터","type":"성장주","score":5,"verdict":"매수","pe_ratio":20,"peg_ratio":0.8,"div_yield":null,"revenue_growth":20,"analyst_buy_pct":80,"checks":{"c1_profit":true,"c2_revenue":true,"c3_analyst":true,"c4_eps":true,"c5_valuation":true,"c6_morningstar":false,"c7_timing":true},"summary":"2문장 투자 포인트","risk":"핵심 리스크"}]}\n\`\`\``
    navigator.clipboard?.writeText(prompt)
    setRecStatus({ type:'', title:'추천 요청이 클립보드에 복사됐어요!', sub:'Claude.ai 채팅창에 붙여넣기(Ctrl+V) 후 응답 JSON을 아래에 붙여넣으세요' })
  }

  const onRpaste = (v: string) => {
    setRpaste(v)
    const p = tryParseJSON(v)
    setRpHint(p?.recommendations ? `✓ ${p.recommendations.length}개 종목 인식됨 — "추천 카드 생성" 클릭` : 'JSON 형식을 확인해주세요')
  }

  const applyRec = () => {
    const p = tryParseJSON(rpaste)
    if (!p?.recommendations) { alert('올바른 JSON 형식이 아니에요'); return }
    setRecCards(p.recommendations)
    setRecStatus({ type:'ok', title:`${p.recommendations.length}개 종목 추천 완료`, sub: p.conditions_summary || '' })
    setRpaste(''); setRpHint('JSON을 붙여넣으면 카드로 렌더링돼요')
  }

  const goAnalyse = (t: string) => { setTicker(t); setView('analysis') }

  const togFilter = (group: string, val: string) => {
    if (group === 'sectors') {
      if (val === '전체') { setFilters(f => ({ ...f, sectors: ['전체'] })); return }
      setFilters(f => {
        const s = f.sectors.filter(x => x !== '전체')
        const next = s.includes(val) ? s.filter(x => x !== val) : [...s, val]
        return { ...f, sectors: next.length ? next : ['전체'] }
      })
    } else {
      setFilters(f => ({ ...f, [group]: val }))
    }
  }

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', fontFamily:'Pretendard, sans-serif', color:'#888' }}>
      로딩 중...
    </div>
  )

  // ── RENDER ─────────────────────────────────────────────
  return (
    <div style={{ background:'var(--bg)', minHeight:'100vh', color:'var(--ink)', fontFamily:'Pretendard, sans-serif' }}>

      {/* NAV */}
      <nav style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'13px 24px', borderBottom:'1.5px solid var(--ink)', background:'var(--bg)', position:'sticky', top:0, zIndex:50 }}>
        <div style={{ fontFamily:'MaruBuri, serif', fontSize:18, fontWeight:700 }}>
          Stocklog<span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', background:'var(--lime)', marginLeft:2, marginBottom:2, verticalAlign:'middle' }}></span>
        </div>
        <div style={{ display:'flex', gap:2 }}>
          {(['rec','analysis','journal','portfolio','rebalance'] as const).map((v, i) => (
            <button key={v} onClick={() => setView(v)}
              style={{ background: view===v ? 'var(--ink)' : 'none', color: view===v ? 'var(--bg)' : 'var(--ink3)', border:'none', fontFamily:'Pretendard, sans-serif', fontSize:11, fontWeight:500, letterSpacing:'0.04em', padding:'7px 14px', cursor:'pointer', borderRadius:3, transition:'all 0.15s' }}>
              {['추천','분석','일지','포트폴리오','리밸런싱'][i]}
            </button>
          ))}
        </div>
      </nav>

      <div style={{ padding:'26px 24px', maxWidth:1100, margin:'0 auto' }}>

        {/* ══ RECOMMEND ══ */}
        {view === 'rec' && (
          <div>
            <div style={{ display:'inline-block', fontSize:9, fontWeight:600, letterSpacing:'0.16em', textTransform:'uppercase', color:'var(--ink)', background:'var(--lime)', padding:'3px 10px', borderRadius:2, marginBottom:10 }}>AI 종목 추천</div>
            <div style={{ fontFamily:'MaruBuri, serif', fontSize:34, fontWeight:700, lineHeight:1.05, letterSpacing:'-0.02em', marginBottom:22 }}>
              조건에 맞는<br /><span style={{ position:'relative' }}>종목<span style={{ position:'absolute', left:0, bottom:2, width:'100%', height:3, background:'var(--lime)' }}></span></span>을 찾아드려요.
            </div>

            {/* FILTERS */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(180px,1fr))', gap:12, marginBottom:20 }}>
              {[
                { key:'style', label:'투자 성향', opts:['안정추구형','위험중립형','위험감수형'], multi:false },
                { key:'type', label:'종목 유형', opts:['둘 다','배당주 위주','성장주 위주','ETF 포함'], multi:false },
                { key:'cap', label:'시가총액', opts:['전체','대형주 ($10B+)','중형주 ($2B-10B)','소형주 ($2B 미만)'], multi:false },
                { key:'cycle', label:'경기 사이클', opts:['현재 사이클 자동 반영','경기 확장기','경기 둔화기','경기 침체기'], multi:false },
                { key:'score', label:'최소 통과 기준', opts:['5개 이상 통과','4개 이상 통과','3개 이상 통과'], multi:false },
              ].map(f => (
                <div key={f.key} style={{ background:'var(--surface)', borderRadius:6, padding:'14px 16px' }}>
                  <div style={{ fontSize:8, fontWeight:600, letterSpacing:'0.14em', textTransform:'uppercase', color:'var(--ink3)', marginBottom:8 }}>{f.label}</div>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                    {f.opts.map(o => {
                      const sel = (filters as Record<string, unknown>)[f.key] === o
                      return (
                        <button key={o} onClick={() => togFilter(f.key, o)}
                          style={{ background: sel ? 'var(--ink)' : 'var(--bg)', color: sel ? 'var(--bg)' : 'var(--ink2)', border:`1.5px solid ${sel ? 'var(--ink)' : 'var(--rule)'}`, fontSize:10, fontWeight:500, padding:'5px 11px', borderRadius:3, cursor:'pointer', transition:'all 0.15s' }}>
                          {o}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              {/* Sector filter */}
              <div style={{ background:'var(--surface)', borderRadius:6, padding:'14px 16px' }}>
                <div style={{ fontSize:8, fontWeight:600, letterSpacing:'0.14em', textTransform:'uppercase', color:'var(--ink3)', marginBottom:8 }}>섹터 (복수 선택)</div>
                <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                  {['전체','정보기술','헬스케어','필수소비재','금융','산업재','임의소비재','유틸리티'].map(o => {
                    const sel = filters.sectors.includes(o)
                    return (
                      <button key={o} onClick={() => togFilter('sectors', o)}
                        style={{ background: sel ? 'var(--ink)' : 'var(--bg)', color: sel ? 'var(--bg)' : 'var(--ink2)', border:`1.5px solid ${sel ? 'var(--ink)' : 'var(--rule)'}`, fontSize:10, fontWeight:500, padding:'5px 11px', borderRadius:3, cursor:'pointer', transition:'all 0.15s' }}>
                        {o}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>

            <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap', marginBottom:16 }}>
              <button onClick={reqRec} style={{ background:'var(--ink)', color:'var(--bg)', border:'none', fontFamily:'Pretendard', fontSize:11, fontWeight:600, letterSpacing:'0.08em', textTransform:'uppercase', padding:'11px 22px', cursor:'pointer', borderRadius:3 }}>AI에게 추천 요청 ↗</button>
              <span style={{ fontSize:10, color:'var(--ink3)' }}>→ 클립보드에 복사됩니다. Claude.ai에 붙여넣은 후 응답 JSON을 아래에 붙여넣으세요.</span>
            </div>

            {/* Paste */}
            <div style={{ background: rpaste && tryParseJSON(rpaste)?.recommendations ? 'var(--lime-bg)' : 'var(--surface)', border:`1.5px dashed ${rpaste && tryParseJSON(rpaste)?.recommendations ? 'var(--lime-dim)' : 'rgba(0,0,0,0.15)'}`, borderRadius:6, padding:'14px 16px', marginBottom:18 }}>
              <div style={{ fontSize:9, fontWeight:600, letterSpacing:'0.14em', textTransform:'uppercase', color:'var(--ink3)', marginBottom:6 }}>AI 응답 붙여넣기</div>
              <textarea value={rpaste} onChange={e => onRpaste(e.target.value)}
                placeholder='AI가 돌려준 recommendations JSON을 여기에 붙여넣으세요'
                style={{ width:'100%', background:'transparent', border:'none', color:'var(--ink)', fontFamily:'Pretendard', fontSize:11, lineHeight:1.5, resize:'vertical', height:68, outline:'none' }} />
              <div style={{ display:'flex', gap:8, marginTop:8, alignItems:'center' }}>
                <span style={{ fontSize:10, color:'var(--ink3)', flex:1 }}>{rpHint}</span>
                <button onClick={applyRec} style={{ background:'var(--lime)', color:'var(--ink)', border:'none', fontFamily:'Pretendard', fontSize:10, fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', padding:'7px 16px', cursor:'pointer', borderRadius:3 }}>추천 카드 생성 →</button>
              </div>
            </div>

            {/* Status */}
            <div style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'11px 14px', borderRadius:5, marginBottom:18, fontSize:11, border:'1px solid', borderColor: recStatus.type==='ok' ? 'rgba(26,158,58,0.2)' : 'var(--rule)', background: recStatus.type==='ok' ? 'rgba(26,158,58,0.07)' : 'var(--surface)', color: recStatus.type==='ok' ? 'var(--green)' : 'var(--ink3)' }}>
              <span style={{ fontSize:13, flexShrink:0 }}>{recStatus.type==='ok' ? '✅' : '💡'}</span>
              <div><div style={{ fontWeight:600 }}>{recStatus.title}</div><div style={{ fontSize:10, opacity:0.75, marginTop:1 }}>{recStatus.sub}</div></div>
            </div>

            {/* Rec Cards */}
            {recCards.length > 0 && (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px,1fr))', gap:14 }}>
                {recCards.map(r => {
                  const vc = r.verdict === '매수' ? '#1fd648' : r.verdict === '관찰' ? '#f5a623' : 'var(--red)'
                  const sc = r.score >= 5 ? 'var(--lime-dim)' : r.score >= 4 ? '#c47d0a' : 'var(--red)'
                  const ckKeys = ['c1_profit','c2_revenue','c3_analyst','c4_eps','c5_valuation','c6_morningstar','c7_timing']
                  return (
                    <div key={r.ticker} style={{ background:'var(--bg)', border:'1.5px solid var(--rule)', borderRadius:8, padding:18, position:'relative', overflow:'hidden' }}>
                      <div style={{ position:'absolute', top:0, left:0, right:0, height:3, background:vc }}></div>
                      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10 }}>
                        <div>
                          <div style={{ fontFamily:'MaruBuri, serif', fontSize:22, fontWeight:700 }}>{r.ticker}</div>
                          <div style={{ fontSize:10, color:'var(--ink3)', marginTop:2 }}>{r.name} · {r.sector}</div>
                        </div>
                        <div style={{ textAlign:'right' }}>
                          <div style={{ fontFamily:'MaruBuri, serif', fontSize:28, fontWeight:700, lineHeight:1, color:sc }}>{r.score}</div>
                          <div style={{ fontSize:8, color:'var(--ink3)', letterSpacing:'0.1em' }}>/7점</div>
                        </div>
                      </div>
                      <div style={{ display:'inline-block', fontSize:8, fontWeight:700, letterSpacing:'0.12em', textTransform:'uppercase', padding:'3px 10px', borderRadius:2, marginBottom:10, color:vc, background:`${vc}22`, border:`1px solid ${vc}55` }}>{r.verdict} · {r.type}</div>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:10 }}>
                        {[['PER', r.pe_ratio], ['PEG', r.peg_ratio], ['매출성장', r.revenue_growth ? `+${r.revenue_growth}%` : '—'], ['매수의견', r.analyst_buy_pct ? `${r.analyst_buy_pct}%` : '—']].map(([l,v]) => (
                          <div key={String(l)} style={{ background:'var(--surface)', borderRadius:4, padding:'7px 10px' }}>
                            <div style={{ fontSize:7, fontWeight:600, letterSpacing:'0.12em', textTransform:'uppercase', color:'var(--ink3)', marginBottom:2 }}>{l}</div>
                            <div style={{ fontSize:13, fontWeight:600 }}>{v ?? '—'}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:10 }}>
                        {ckKeys.map((k,i) => {
                          const v = r.checks?.[k]
                          return <div key={k} style={{ width:18, height:18, borderRadius:3, display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:700, background: v===true ? 'rgba(26,158,58,0.12)' : v===false ? 'rgba(217,43,43,0.1)' : 'var(--surface)', color: v===true ? 'var(--green)' : v===false ? 'var(--red)' : 'var(--ink3)' }}>
                            {v===true ? '✓' : v===false ? '✗' : '?'}
                          </div>
                        })}
                      </div>
                      <div style={{ fontSize:10, color:'var(--ink2)', lineHeight:1.55, marginBottom:10 }}>{r.summary}</div>
                      <div style={{ background:'rgba(217,43,43,0.06)', borderLeft:'2px solid rgba(217,43,43,0.3)', padding:'8px 10px', borderRadius:'0 4px 4px 0', marginBottom:10 }}>
                        <div style={{ fontSize:8, fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', color:'var(--red)', opacity:0.8, marginBottom:3 }}>리스크</div>
                        <div style={{ fontSize:10, color:'var(--ink2)', lineHeight:1.5 }}>{r.risk}</div>
                      </div>
                      <button onClick={() => goAnalyse(r.ticker)} style={{ width:'100%', background:'var(--ink)', color:'var(--bg)', border:'none', fontFamily:'Pretendard', fontSize:10, fontWeight:600, letterSpacing:'0.08em', textTransform:'uppercase', padding:8, cursor:'pointer', borderRadius:3 }}>상세 분석하기 →</button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ══ ANALYSIS ══ */}
        {view === 'analysis' && (
          <div>
            <div style={{ display:'inline-block', fontSize:9, fontWeight:600, letterSpacing:'0.16em', textTransform:'uppercase', color:'var(--ink)', background:'var(--lime)', padding:'3px 10px', borderRadius:2, marginBottom:10 }}>AI 종목 분석</div>
            <div style={{ fontFamily:'MaruBuri, serif', fontSize:34, fontWeight:700, lineHeight:1.05, letterSpacing:'-0.02em', marginBottom:22 }}>
              사기 전에,<br /><span style={{ position:'relative' }}>확인<span style={{ position:'absolute', left:0, bottom:2, width:'100%', height:3, background:'var(--lime)' }}></span></span>하세요.
            </div>

            {/* HOW IT WORKS */}
            <div style={{ background:'var(--ink)', color:'var(--bg)', borderRadius:7, padding:'14px 18px', marginBottom:18, display:'flex', gap:16, flexWrap:'wrap' }}>
              {[['1','티커 입력 후 "AI에게 요청" 클릭','요청이 클립보드에 복사돼요'],['2','Claude.ai에 붙여넣기','AI가 데이터 조회 후 JSON 답변'],['3','"데이터 적용" 클릭','7가지 항목 자동 채워짐']].map(([n,t,s]) => (
                <div key={n} style={{ display:'flex', alignItems:'flex-start', gap:8, flex:1, minWidth:140 }}>
                  <div style={{ fontFamily:'MaruBuri, serif', fontSize:20, fontWeight:700, color:'var(--lime)', lineHeight:1, flexShrink:0 }}>{n}</div>
                  <div style={{ fontSize:10, lineHeight:1.5, color:'#aaa' }}><strong style={{ color:'var(--bg)', fontWeight:600 }}>{t}</strong><br/>{s}</div>
                </div>
              ))}
            </div>

            <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap', marginBottom:14 }}>
              <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} onKeyDown={e => e.key==='Enter' && reqAnalysis()}
                placeholder="티커 입력" maxLength={6}
                style={{ background:'transparent', border:'none', borderBottom:'2px solid var(--ink)', color:'var(--ink)', fontFamily:'MaruBuri, serif', fontSize:20, fontWeight:700, letterSpacing:'0.06em', padding:'6px 0 8px', width:150, outline:'none' }} />
              <button onClick={reqAnalysis} style={{ background:'var(--ink)', color:'var(--bg)', border:'none', fontFamily:'Pretendard', fontSize:11, fontWeight:600, letterSpacing:'0.08em', textTransform:'uppercase', padding:'11px 22px', cursor:'pointer', borderRadius:3 }}>AI에게 요청 ↗</button>
              {ticker && (
                <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                  {[['stockanalysis',`https://stockanalysis.com/stocks/${ticker.toLowerCase()}/financials/`],['morningstar',`https://www.morningstar.com/stocks/xnas/${ticker.toLowerCase()}/quote`],['investing',`https://www.investing.com/search/?q=${ticker}`],['yahoo',`https://finance.yahoo.com/quote/${ticker}`]].map(([n,u]) => (
                    <a key={n} href={u} target="_blank" rel="noopener noreferrer"
                      style={{ fontFamily:'Pretendard', fontSize:10, fontWeight:500, color:'var(--ink2)', textDecoration:'none', padding:'5px 11px', border:'1px solid var(--rule)', borderRadius:3, background:'var(--surface)' }}>
                      {n} ↗
                    </a>
                  ))}
                </div>
              )}
            </div>

            {/* Paste */}
            <div style={{ background: apaste && tryParseJSON(apaste)?.ticker ? 'var(--lime-bg)' : 'var(--surface)', border:`1.5px dashed ${apaste && tryParseJSON(apaste)?.ticker ? 'var(--lime-dim)' : 'rgba(0,0,0,0.15)'}`, borderRadius:6, padding:'14px 16px', marginBottom:18 }}>
              <div style={{ fontSize:9, fontWeight:600, letterSpacing:'0.14em', textTransform:'uppercase', color:'var(--ink3)', marginBottom:6 }}>AI 응답 붙여넣기</div>
              <textarea value={apaste} onChange={e => onApaste(e.target.value)}
                placeholder='AI가 돌려준 JSON을 여기에 붙여넣으세요'
                style={{ width:'100%', background:'transparent', border:'none', color:'var(--ink)', fontFamily:'Pretendard', fontSize:11, lineHeight:1.5, resize:'vertical', height:68, outline:'none' }} />
              <div style={{ display:'flex', gap:8, marginTop:8, alignItems:'center' }}>
                <span style={{ fontSize:10, color:'var(--ink3)', flex:1 }}>{apHint}</span>
                <button onClick={applyAnalysis} style={{ background:'var(--lime)', color:'var(--ink)', border:'none', fontFamily:'Pretendard', fontSize:10, fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', padding:'7px 16px', cursor:'pointer', borderRadius:3 }}>데이터 적용 →</button>
              </div>
            </div>

            {/* Status */}
            <div style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'11px 14px', borderRadius:5, marginBottom:18, fontSize:11, border:'1px solid', borderColor: analysisStatus.type==='ok' ? 'rgba(26,158,58,0.2)' : 'var(--rule)', background: analysisStatus.type==='ok' ? 'rgba(26,158,58,0.07)' : 'var(--surface)', color: analysisStatus.type==='ok' ? 'var(--green)' : 'var(--ink3)' }}>
              <span style={{ fontSize:13, flexShrink:0 }}>{analysisStatus.type==='ok' ? '✅' : '💡'}</span>
              <div><div style={{ fontWeight:600 }}>{analysisStatus.title}</div><div style={{ fontSize:10, opacity:0.75, marginTop:1 }}>{analysisStatus.sub}</div></div>
            </div>

            {/* Criteria + Score */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 192px', gap:24 }}>
              <div>
                {CR.map(c => {
                  const st = crit[c.id]?.status || 'neutral'
                  const isAI = crit[c.id]?._ai
                  return (
                    <div key={c.id} style={{ padding:'15px 0', borderBottom:'1px solid var(--rule2)', display:'flex', gap:14, alignItems:'flex-start' }}>
                      <div style={{ fontSize:9, fontWeight:600, color:'var(--lime-dim)', letterSpacing:'0.1em', width:26, flexShrink:0, marginTop:3 }}>{c.n}</div>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:'var(--ink)', marginBottom:3, display:'flex', alignItems:'center', gap:8 }}>
                          <span onClick={() => toggleCrit(c.id)} style={{ width:9, height:9, borderRadius:'50%', border:`1.5px solid ${st==='pass' ? 'var(--green)' : st==='fail' ? 'var(--red)' : 'var(--ink3)'}`, cursor:'pointer', display:'inline-block', flexShrink:0, background: st==='pass' ? 'var(--green)' : st==='fail' ? 'var(--red)' : 'transparent', transition:'all 0.2s' }}></span>
                          <span style={{ fontSize:10, fontWeight:700, color: st==='pass' ? 'var(--green)' : st==='fail' ? 'var(--red)' : 'var(--ink3)' }}>{st==='pass' ? '✓' : st==='fail' ? '✗' : '○'}</span>
                          {c.t}
                          {isAI && <span style={{ fontSize:8, fontWeight:700, letterSpacing:'0.06em', color:'var(--lime-dim)', background:'var(--lime-bg)', border:'1px solid rgba(56,255,98,0.35)', padding:'2px 8px', borderRadius:10 }}>AI 조회</span>}
                        </div>
                        <div style={{ fontSize:10, color:'var(--ink3)', lineHeight:1.55 }}>{c.d}</div>
                        <div style={{ display:'flex', gap:10, marginTop:9, flexWrap:'wrap', alignItems:'flex-end' }}>
                          {c.f.map(f => (
                            <div key={f.id} style={{ display:'flex', flexDirection:'column', gap:3 }}>
                              <div style={{ fontSize:8, fontWeight:600, letterSpacing:'0.12em', textTransform:'uppercase', color:'var(--ink3)' }}>{f.l}</div>
                              {f.tp === 'select' ? (
                                <select value={String(crit[c.id]?.[f.id] || '—')} onChange={e => { const nc = { ...crit, [c.id]: { ...crit[c.id], [f.id]: e.target.value } }; saveCrit(nc) }}
                                  style={{ background:'var(--surface)', border:'1px solid var(--rule)', color:'var(--ink)', fontFamily:'Pretendard', fontSize:11, padding:'5px 9px', borderRadius:3, width:115, outline:'none' }}>
                                  {f.opts?.map(o => <option key={o}>{o}</option>)}
                                </select>
                              ) : (
                                <input type={f.tp} placeholder={f.ph} value={String(crit[c.id]?.[f.id] || '')} onChange={e => { const nc = { ...crit, [c.id]: { ...crit[c.id], [f.id]: e.target.value } }; saveCrit(nc) }}
                                  style={{ background: crit[c.id]?._ai && crit[c.id]?.[f.id] ? 'var(--lime-bg)' : 'var(--surface)', border:`1px solid ${crit[c.id]?._ai && crit[c.id]?.[f.id] ? 'rgba(56,255,98,0.5)' : 'var(--rule)'}`, color:'var(--ink)', fontFamily:'Pretendard', fontSize:11, padding:'5px 9px', borderRadius:3, width:115, outline:'none', fontWeight: crit[c.id]?._ai && crit[c.id]?.[f.id] ? 600 : 400 }} />
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Score Panel */}
              <div style={{ background:'var(--ink)', borderRadius:6, padding:20, display:'flex', flexDirection:'column' }}>
                <div style={{ fontSize:8, fontWeight:600, letterSpacing:'0.2em', textTransform:'uppercase', color:'#555', marginBottom:6 }}>점수</div>
                <div style={{ fontFamily:'MaruBuri, serif', fontSize:64, fontWeight:700, lineHeight:0.9, color: scoreAllN ? '#333' : scorePass>=5 ? 'var(--lime)' : scorePass>=3 ? '#aaa' : '#ff6b6b' }}>{scoreAllN ? '—' : scorePass}</div>
                <div style={{ fontSize:13, color:'#555', marginBottom:14 }}>/7점</div>
                <div style={{ fontSize:9, fontWeight:700, letterSpacing:'0.12em', textTransform:'uppercase', padding:'5px 12px', borderRadius:3, marginBottom:18, display:'inline-block',
                  background: verdict==='none' ? '#222' : verdict==='buy' ? 'rgba(56,255,98,0.15)' : verdict==='watch' ? 'rgba(56,255,98,0.08)' : 'rgba(217,43,43,0.15)',
                  color: verdict==='none' ? '#555' : verdict==='buy' ? 'var(--lime)' : verdict==='watch' ? '#6ddd80' : '#ff6b6b',
                  border: `1px solid ${verdict==='none' ? 'transparent' : verdict==='buy' ? 'rgba(56,255,98,0.3)' : verdict==='watch' ? 'rgba(56,255,98,0.2)' : 'rgba(217,43,43,0.3)'}` }}>
                  {verdict==='none' ? '미평가' : verdict==='buy' ? '매수 ↑' : verdict==='watch' ? '관찰 →' : '패스 ✗'}
                </div>
                {[['퀄리티', CR.filter(c=>c.g==='q'&&crit[c.id]?.status==='pass').length/4, 'var(--lime)'],
                  ['밸류', CR.filter(c=>c.g==='v'&&crit[c.id]?.status==='pass').length/2, '#aaa'],
                  ['타이밍', CR.filter(c=>c.g==='t'&&crit[c.id]?.status==='pass').length/1, '#888']
                ].map(([l, ratio, col]) => (
                  <div key={String(l)} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
                    <div style={{ fontSize:8, fontWeight:600, letterSpacing:'0.1em', color:'#555', width:50, flexShrink:0 }}>{l}</div>
                    <div style={{ flex:1, height:2, background:'#222', borderRadius:1 }}>
                      <div style={{ height:'100%', width:`${Math.round(Number(ratio)*100)}%`, background:String(col), borderRadius:1, transition:'width 0.5s ease' }}></div>
                    </div>
                  </div>
                ))}
                <button onClick={() => alert(`${ticker || '종목'} 분석 저장 완료!`)}
                  style={{ width:'100%', background:'transparent', border:'1px solid #333', color:'#666', fontFamily:'Pretendard', fontSize:10, fontWeight:500, letterSpacing:'0.08em', textTransform:'uppercase', padding:9, cursor:'pointer', borderRadius:3, marginTop:'auto' }}>
                  분석 저장 ↓
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ══ JOURNAL ══ */}
        {view === 'journal' && (
          <div>
            <div style={{ display:'inline-block', fontSize:9, fontWeight:600, letterSpacing:'0.16em', textTransform:'uppercase', color:'var(--ink)', background:'var(--lime)', padding:'3px 10px', borderRadius:2, marginBottom:10 }}>매매 기록</div>
            <div style={{ fontFamily:'MaruBuri, serif', fontSize:34, fontWeight:700, lineHeight:1.05, letterSpacing:'-0.02em', marginBottom:22 }}>
              나의<br /><span style={{ position:'relative' }}>트레이드<span style={{ position:'absolute', left:0, bottom:2, width:'100%', height:3, background:'var(--lime)' }}></span></span> 일지.
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:22 }}>
              <div style={{ fontSize:11, color:'var(--ink3)', fontWeight:500 }}>{trades.length}건 기록됨</div>
              <button onClick={() => setShowTradeForm(v => !v)} style={{ background:'transparent', border:'1.5px solid var(--ink)', color:'var(--ink)', fontFamily:'Pretendard', fontSize:11, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase', padding:'9px 18px', cursor:'pointer', borderRadius:3 }}>+ 거래 추가</button>
            </div>

            {showTradeForm && (
              <div style={{ background:'var(--surface)', borderLeft:'3px solid var(--lime)', borderRadius:4, padding:20, marginBottom:20 }}>
                <div style={{ display:'flex', gap:6, marginBottom:16 }}>
                  {(['BUY','SELL'] as const).map(t => (
                    <button key={t} onClick={() => setTradeType(t)}
                      style={{ background: tradeType===t ? (t==='BUY' ? 'var(--green)' : 'var(--red)') : 'transparent', color: tradeType===t ? '#fff' : 'var(--ink3)', border:`1.5px solid ${tradeType===t ? (t==='BUY' ? 'var(--green)' : 'var(--red)') : 'var(--rule)'}`, fontFamily:'Pretendard', fontSize:10, fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', padding:'7px 20px', cursor:'pointer', borderRadius:3 }}>
                      {t==='BUY' ? '매수' : '매도'}
                    </button>
                  ))}
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(115px,1fr))', gap:14, marginBottom:14 }}>
                  {[['ticker','티커','text'],['date','날짜','date'],['price','가격 ($)','number'],['qty','수량','number'],['score','점수 /7','number']].map(([k,l,t]) => (
                    <div key={k}>
                      <label style={{ display:'block', fontSize:8, fontWeight:600, letterSpacing:'0.14em', textTransform:'uppercase', color:'var(--ink3)', marginBottom:4 }}>{l}</label>
                      <input type={t} value={String(jForm[k as keyof typeof jForm])} onChange={e => setJForm(f => ({ ...f, [k]: t==='text' ? e.target.value.toUpperCase() : e.target.value }))}
                        placeholder={t==='number' ? '0' : ''}
                        style={{ width:'100%', background:'var(--bg)', border:'1px solid var(--rule)', color:'var(--ink)', fontFamily:'Pretendard', fontSize:12, padding:'7px 10px', borderRadius:3, outline:'none' }} />
                    </div>
                  ))}
                  <div>
                    <label style={{ display:'block', fontSize:8, fontWeight:600, letterSpacing:'0.14em', textTransform:'uppercase', color:'var(--ink3)', marginBottom:4 }}>매수 이유</label>
                    <select value={jForm.reason} onChange={e => setJForm(f => ({ ...f, reason: e.target.value }))}
                      style={{ width:'100%', background:'var(--bg)', border:'1px solid var(--rule)', color:'var(--ink)', fontFamily:'Pretendard', fontSize:12, padding:'7px 10px', borderRadius:3, outline:'none' }}>
                      {['—','안정적 매출 성장','PEG < 1 저평가','배당 성장주','경기사이클 대응','리밸런싱','악재 없는 주가 하락','실적 증가 확인','기타'].map(o => <option key={o}>{o}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ marginBottom:14 }}>
                  <label style={{ display:'block', fontSize:8, fontWeight:600, letterSpacing:'0.14em', textTransform:'uppercase', color:'var(--ink3)', marginBottom:4 }}>메모</label>
                  <textarea value={jForm.memo} onChange={e => setJForm(f => ({ ...f, memo: e.target.value }))}
                    placeholder="투자 근거, 리스크, 아이디어..." rows={3}
                    style={{ width:'100%', background:'var(--bg)', border:'1px solid var(--rule)', color:'var(--ink)', fontFamily:'Pretendard', fontSize:11, padding:'7px 10px', borderRadius:3, outline:'none', resize:'vertical' }} />
                </div>
                <button onClick={saveTrade} style={{ background:'var(--lime)', color:'var(--ink)', border:'none', fontFamily:'Pretendard', fontSize:11, fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', padding:'11px 22px', cursor:'pointer', borderRadius:3 }}>저장하기 →</button>
              </div>
            )}

            {trades.length === 0 ? (
              <div style={{ padding:'48px 0', textAlign:'center', fontFamily:'MaruBuri, serif', fontSize:14, color:'var(--ink3)' }}>아직 기록된 거래가 없어요</div>
            ) : (
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                  <thead>
                    <tr>{['티커','구분','날짜','가격','수량','총액','점수','이유',''].map(h => (
                      <th key={h} style={{ fontSize:8, fontWeight:600, letterSpacing:'0.14em', textTransform:'uppercase', color:'var(--ink3)', padding:'10px 12px', textAlign:'left', borderBottom:'1.5px solid var(--ink)' }}>{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {trades.map(t => (
                      <tr key={t.id} style={{ cursor:'default' }}>
                        <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', verticalAlign:'middle' }}><span style={{ fontFamily:'MaruBuri, serif', fontSize:14, fontWeight:700 }}>{t.ticker}</span></td>
                        <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', verticalAlign:'middle' }}><span style={{ fontSize:8, fontWeight:700, letterSpacing:'0.1em', textTransform:'uppercase', padding:'3px 9px', borderRadius:3, color: t.type==='BUY' ? 'var(--green)' : 'var(--red)', background: t.type==='BUY' ? 'rgba(26,158,58,0.1)' : 'rgba(217,43,43,0.1)' }}>{t.type==='BUY' ? '매수' : '매도'}</span></td>
                        <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', color:'var(--ink2)', fontSize:11 }}>{t.date}</td>
                        <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', fontWeight:500, color:'var(--ink)' }}>${Number(t.price).toFixed(2)}</td>
                        <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', color:'var(--ink2)' }}>{Number(t.qty).toFixed(4)}</td>
                        <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', fontWeight:600, color:'var(--ink)' }}>${(t.price * t.qty).toLocaleString(undefined, { maximumFractionDigits:0 })}</td>
                        <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', color:'var(--ink3)' }}>{t.score ? `${t.score}/7` : '—'}</td>
                        <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', fontSize:10, maxWidth:100, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--ink2)' }}>{t.reason || '—'}</td>
                        <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)' }}><button onClick={() => deleteTrade(t.id)} style={{ background:'none', border:'none', color:'var(--ink3)', cursor:'pointer', fontSize:12, padding:'2px 6px', borderRadius:2 }}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══ PORTFOLIO ══ */}
        {view === 'portfolio' && (
          <div>
            <div style={{ display:'inline-block', fontSize:9, fontWeight:600, letterSpacing:'0.16em', textTransform:'uppercase', color:'var(--ink)', background:'var(--lime)', padding:'3px 10px', borderRadius:2, marginBottom:10 }}>포트폴리오</div>
            <div style={{ fontFamily:'MaruBuri, serif', fontSize:34, fontWeight:700, lineHeight:1.05, letterSpacing:'-0.02em', marginBottom:22 }}>
              내 종목<br /><span style={{ position:'relative' }}>현황<span style={{ position:'absolute', left:0, bottom:2, width:'100%', height:3, background:'var(--lime)' }}></span></span>.
            </div>

            {/* Metrics */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(125px,1fr))', gap:1, background:'var(--rule)', border:'1px solid var(--rule)', borderRadius:6, overflow:'hidden', marginBottom:24 }}>
              {[
                ['투자원금', `$${totalCost.toLocaleString(undefined,{maximumFractionDigits:0})}`, ''],
                ['평가금액', totalMv ? `$${totalMv.toLocaleString(undefined,{maximumFractionDigits:0})}` : '—', ''],
                ['총 손익', totalMv ? `${totalPnl>=0?'+':''}$${Math.abs(totalPnl).toLocaleString(undefined,{maximumFractionDigits:0})}` : '—', totalMv ? (totalPnl>=0 ? 'var(--green)' : 'var(--red)') : ''],
                ['수익률', totalRet !== null ? `${totalRet>=0?'+':''}${totalRet.toFixed(1)}%` : '—', totalRet !== null ? (totalRet>=0 ? 'var(--green)' : 'var(--red)') : ''],
                ['보유 종목', String(holdings.length), ''],
              ].map(([l,v,c]) => (
                <div key={String(l)} style={{ background:'var(--bg)', padding:'14px 16px' }}>
                  <div style={{ fontSize:8, fontWeight:600, letterSpacing:'0.16em', textTransform:'uppercase', color:'var(--ink3)', marginBottom:4 }}>{l}</div>
                  <div style={{ fontFamily:'MaruBuri, serif', fontSize:22, fontWeight:700, color: c || 'var(--ink)' }}>{v}</div>
                </div>
              ))}
            </div>

            {holdings.length === 0 ? (
              <div style={{ padding:'48px 0', textAlign:'center', fontFamily:'MaruBuri, serif', fontSize:14, color:'var(--ink3)' }}>일지에서 거래를 추가하면 여기에 표시돼요</div>
            ) : (
              <div style={{ overflowX:'auto', marginBottom:20 }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                  <thead><tr>
                    {['티커','보유수','평균단가','현재가 ($)','평가금액','손익','수익률','비중'].map(h => (
                      <th key={h} style={{ fontSize:8, fontWeight:600, letterSpacing:'0.14em', textTransform:'uppercase', color:'var(--ink3)', padding:'10px 12px', textAlign:'left', borderBottom:'1.5px solid var(--ink)' }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {holdings.map(h => {
                      const w = totalWeight > 0 ? ((h.mv || h.avg * h.qty) / totalWeight * 100) : 0
                      const pc = h.pnl === null ? 'var(--ink3)' : h.pnl >= 0 ? 'var(--green)' : 'var(--red)'
                      return (
                        <tr key={h.ticker}>
                          <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)' }}><span style={{ fontFamily:'MaruBuri, serif', fontSize:14, fontWeight:700 }}>{h.ticker}</span></td>
                          <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', color:'var(--ink2)', fontSize:11 }}>{h.qty.toFixed(4)}</td>
                          <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', color:'var(--ink2)', fontSize:11 }}>${h.avg.toFixed(2)}</td>
                          <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)' }}>
                            <input type="number" step="0.01" defaultValue={h.cp || ''} placeholder="입력" onBlur={e => updatePrice(h.ticker, e.target.value)}
                              style={{ width:80, background:'var(--surface)', border:'1px solid var(--rule)', color:'var(--ink)', fontFamily:'Pretendard', fontSize:11, padding:'4px 8px', borderRadius:3, outline:'none' }} />
                          </td>
                          <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', fontWeight:600, color:'var(--ink)' }}>{h.mv ? `$${h.mv.toLocaleString(undefined,{maximumFractionDigits:0})}` : '—'}</td>
                          <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', fontWeight:600, color:pc }}>{h.pnl !== null ? `${h.pnl>=0?'+':''}$${Math.abs(h.pnl).toLocaleString(undefined,{maximumFractionDigits:0})}` : '—'}</td>
                          <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)', color:pc }}>{h.pct !== null ? `${h.pct>=0?'+':''}${h.pct.toFixed(1)}%` : '—'}</td>
                          <td style={{ padding:'12px', borderBottom:'1px solid var(--rule2)' }}>
                            <span style={{ fontSize:10, color:'var(--ink3)' }}>{w.toFixed(1)}%</span>
                            <span style={{ display:'block', height:2, background:'var(--lime-dim)', opacity:0.5, borderRadius:1, marginTop:3, width: Math.min(w,60) }}></span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Price Update */}
            <div style={{ display:'flex', gap:10, alignItems:'center', paddingTop:16, borderTop:'1px solid var(--rule2)', flexWrap:'wrap' }}>
              <span style={{ fontSize:9, fontWeight:600, letterSpacing:'0.12em', textTransform:'uppercase', color:'var(--ink3)' }}>현재가 업데이트 →</span>
              <input value={priceInput.ticker} onChange={e => setPriceInput(p => ({ ...p, ticker: e.target.value.toUpperCase() }))} placeholder="TICKER"
                style={{ background:'var(--surface)', border:'1px solid var(--rule)', color:'var(--ink)', fontFamily:'Pretendard', fontSize:11, padding:'6px 10px', borderRadius:3, width:80, outline:'none' }} />
              <input type="number" step="0.01" value={priceInput.val} onChange={e => setPriceInput(p => ({ ...p, val: e.target.value }))} placeholder="$0.00"
                style={{ background:'var(--surface)', border:'1px solid var(--rule)', color:'var(--ink)', fontFamily:'Pretendard', fontSize:11, padding:'6px 10px', borderRadius:3, width:80, outline:'none' }} />
              <button onClick={() => { updatePrice(priceInput.ticker, priceInput.val); setPriceInput({ ticker:'', val:'' }) }}
                style={{ background:'var(--ink)', color:'var(--bg)', border:'none', fontFamily:'Pretendard', fontSize:10, fontWeight:600, letterSpacing:'0.08em', textTransform:'uppercase', padding:'8px 14px', cursor:'pointer', borderRadius:3 }}>
                업데이트
              </button>
            </div>
          </div>
        )}

        {/* ══ REBALANCE ══ */}
        {view === 'rebalance' && (
          <div>
            <div style={{ display:'inline-block', fontSize:9, fontWeight:600, letterSpacing:'0.16em', textTransform:'uppercase', color:'var(--ink)', background:'var(--lime)', padding:'3px 10px', borderRadius:2, marginBottom:10 }}>리밸런싱</div>
            <div style={{ fontFamily:'MaruBuri, serif', fontSize:34, fontWeight:700, lineHeight:1.05, letterSpacing:'-0.02em', marginBottom:22 }}>
              분기마다<br /><span style={{ position:'relative' }}>점검<span style={{ position:'absolute', left:0, bottom:2, width:'100%', height:3, background:'var(--lime)' }}></span></span>하세요.
            </div>
            <div style={{ background:'var(--surface)', borderLeft:'3px solid var(--lime)', padding:'11px 14px', marginBottom:20, borderRadius:3, fontSize:11, color:'var(--ink2)', lineHeight:1.6 }}>
              <strong style={{ color:'var(--ink)', fontWeight:700 }}>권장 주기: 3개월.</strong> 경기 사이클 → 섹터 수익률 → 금리 방향 순서로 점검. 변경 시 전체 자산의 <strong style={{ color:'var(--ink)', fontWeight:700 }}>5~10% 단위</strong>로만 조정.
            </div>
            {Object.entries(RBI).map(([key, items], si) => (
              <div key={key} style={{ marginBottom:28 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 0', borderBottom:'1.5px solid var(--ink)' }}>
                  <span style={{ fontFamily:'MaruBuri, serif', fontSize:13, fontWeight:700, color:'var(--lime-dim)' }}>#{String(si+1).padStart(2,'0')}</span>
                  <span style={{ fontSize:11, fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase', color:'var(--ink3)' }}>{['경기 사이클 점검','섹터 수익률 점검','금리 방향성 점검','종목 점검'][si]}</span>
                </div>
                {items.map(item => (
                  <div key={item.id} onClick={() => saveRb({ ...rb, [item.id]: !rb[item.id] })}
                    style={{ display:'flex', gap:13, padding:'12px 0', borderBottom:'1px solid var(--rule2)', cursor:'pointer', alignItems:'flex-start', opacity: rb[item.id] ? 0.3 : 1, transition:'opacity 0.2s' }}>
                    <div style={{ width:14, height:14, border:`1.5px solid ${rb[item.id] ? 'var(--lime)' : 'var(--rule)'}`, borderRadius:3, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:8, fontWeight:700, marginTop:2, background: rb[item.id] ? 'var(--lime)' : 'transparent', color: rb[item.id] ? 'var(--ink)' : 'transparent', transition:'all 0.15s' }}>✓</div>
                    <div>
                      <div style={{ fontSize:12, fontWeight:500, color:'var(--ink)', marginBottom:2 }}>{item.m}</div>
                      <div style={{ fontSize:10, color:'var(--ink3)', lineHeight:1.5 }}>{item.d}</div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  )
}
