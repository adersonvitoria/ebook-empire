# Ebook Empire — Viabilidade Financeira (meta R$1.000/dia)

> Analise numerica da meta de **faturamento bruto >= R$1.000/dia** vendendo ebooks com trafego pago Meta. Conclusao executiva: **viavel, mas apenas em uma janela estreita** de eficiencia de midia e AOV. Todo dinheiro e modelado em centavos no codigo (`Int`, BRL); aqui usamos R$ por legibilidade.

## 1. Definicoes e premissas

- **Meta = FATURAMENTO BRUTO** (receita), nao lucro. `sum(Order.priceCents where status=PAID) >= 100.000 centavos/dia`.
- **Lucro liquido alvo** nos cenarios viaveis: **R$280–530/dia**.
- **Tarifa Asaas PIX**: modelada como **fixa ~R$1,99/transacao** (CONFIRMAR no plano contratado — se for percentual, remodelar). Impacto < 4% no ticket R$47. **Nao** e o fator decisivo.
- **Custo de LLM**:
  - Geracao de ebook: **UMA vez** (~R$3/ebook com `claude-sonnet-4-6`, ~40k tokens out), amortizado em centenas de vendas -> desprezivel por venda.
  - Agentes recorrentes (`claude-opus-4-8` orchestrator + copy): **~R$5–20/dia**.
- **Parametros Meta Ads BR (2025/26)**: CPM R$15–35; CPC R$0,80–2,50; CTR p/ LP ~1–2%; **custo por LP-view (LPV/CPV) alvo R$0,50–1,00** com criativos validados.
- **Fator decisivo**: CAC/ROAS (custo por visitante x conversao x AOV). **Nao** as taxas de pagamento.

## 2. Estrutura de oferta (DECISAO FINAL — D9 da ARCHITECTURE)

Ticket R$27 isolado e **estruturalmente deficitario** (exigiria ~37 vendas/dia e CPA < R$25, inatingivel no Meta BR). R$97 isolado converte pouco em trafego frio. Estrutura oficial:

| Componente | Preco | Take-rate modelado | Contribuicao ao AOV |
|---|---|---|---|
| Produto-ancora | R$47 | 100% | R$47,00 |
| Order-bump | R$27 | ~40% | R$10,80 |
| Upsell pos-compra | R$97 | ~15% | R$14,55 |
| **AOV efetivo** | | | **~R$72** |

No schema, cada componente e um `Product` distinto sobre o(s) mesmo(s) `Ebook`(s); `Order.priceCents` snapshota o preco no momento da compra.

## 3. Formulas

```
ROAS                 = revenue / adSpend
ROI                  = (revenue - adSpend) / adSpend
ROAS break-even      = ticket / (ticket - tarifa_asaas)
CPA maximo           = ticket - tarifa_asaas
vendas_necessarias/dia = 1000 / AOV
visitantes/dia       = vendas / taxa_conversao
budget_ads/dia       = visitantes * CPV
CAC                  = adSpend / vendas        (null se vendas=0)
CPA                  = adSpend / conversoes    (null se conversoes=0)
```

Todas null-guarded (denominador zero -> null), conforme `deriveFinancialMetrics`.

### Break-even de ROAS por ticket (tarifa R$1,99)

| Ticket | ROAS break-even | CPA maximo |
|---|---|---|
| R$27 | 1,08x | R$25,01 |
| R$47 | 1,04x | R$45,01 |
| R$97 | 1,02x | R$95,01 |

Break-even contabil fica em ~1,02–1,08x, mas **nao deixa margem**. **Meta operacional: ROAS >= 1,8–2,0x**.

## 4. Cenarios-chave (faturamento alvo R$1.000 bruto/dia)

| Cenario | AOV | Conv. LP | CPV | Vendas/dia | Visitantes/dia | Budget ads/dia | ROAS | Resultado |
|---|---|---|---|---|---|---|---|---|
| A — ticket puro R$47 | R$47 | 2,0% | R$1,00 | 21 | 1.064 | R$1.064 | **0,94x** | **PREJUIZO ~ -R$106/dia** |
| B — ticket puro R$97 | R$97 | 2,0% | R$1,00 | 10 | 515 | R$515 | **1,94x** | **LUCRO ~ +R$464/dia** |
| C — AOV R$72 (oferta oficial) | R$72 | 2,5% | R$0,80 | 14 | 556 | R$444 | **2,26x** | **LUCRO ~ +R$530/dia** |

Leitura:
- **Cenario A** mostra por que ticket baixo isolado nao fecha: o budget para gerar R$1.000 supera a receita.
- **Cenario C (recomendado)** e o alvo operacional: AOV via bump/upsell + CPV controlado + conversao 2,5% -> ROAS 2,26x.
- Diferenca entre A e C e **AOV e CPV**, nao a taxa de pagamento.

### Sensibilidade — o CPV manda

Mantendo AOV R$72 e conversao 2,5%:

| CPV | ROAS aprox. | Veredito |
|---|---|---|
| R$0,60 | ~3,0x | Otimo |
| R$0,80 | ~2,26x | Alvo |
| R$1,00 | ~1,8x | Limite |
| R$1,50 | ~1,2x | **Quase break-even / prejuizo** |

> **Risco #1**: se o CPV real ficar em ~R$1,50 (criativos fracos / nicho competitivo), **todos** os cenarios degradam para perto do break-even ou prejuizo. A producao continua de criativos (Social/Content agents) e o que sustenta o CPV baixo.

## 5. KPIs a expor no dashboard (AnalyticsAgent)

vendas/dia · AOV efetivo · taxa de conversao LP (LANDING_VIEW -> PAID) · CPV/LPV · CPA · CAC · ROAS · ROI · lucro liquido/dia.

Distinguir no funil `Event`: `LANDING_VIEW` != `CHECKOUT_STARTED` != `PAID` para calcular conversao real. Exibir KPI so acima de volume minimo de amostra (evita ROAS gigante de 1 venda).

## 6. Capital de giro

Reserva recomendada de **R$3.000–5.000** para ads durante a fase de aprendizado/validacao de criativos, antes do ROAS estabilizar positivo. Sem essa reserva, o projeto morre antes de achar o criativo vencedor.

## 7. Rampa de budget (4 semanas)

| Semana | Budget/dia | Faturamento alvo/dia | Foco |
|---|---|---|---|
| 1 | R$150 | ~R$150–300 | Validar criativos, achar CPV < R$1 |
| 2 | R$350 | ~R$350–500 | Estabilizar ROAS >= 1,8x |
| 3 | R$600 | ~R$600–800 | Escalar campanhas vencedoras (+20%/ciclo) |
| 4 | R$1.000 | **>= R$1.000** | Operacao-alvo; novos ebooks na esteira |

Escalar conforme ROAS estabiliza, nunca de uma vez. Teto diario de budget via env `MAX_AD_BUDGET_BRL` (guardrail do TrafficAgent).

## 8. Riscos financeiros (ordenados)

1. **CPV/CAC e o unico fator decisivo.** CPV R$1,50 -> prejuizo em todos os cenarios.
2. **Conversao de LP 2–3% e otimista** para trafego 100% frio (muitos ebooks ficam em 0,8–1,5%). Abaixo de 2% nao fecha sem AOV alto.
3. **Dependencia de bump/upsell**: take-rate abaixo de 40%/15% derruba o AOV e evapora a viabilidade.
4. **Saturacao de criativos**: ROAS Meta decai em 1–2 semanas sem producao continua de criativos.
5. **Ban da conta de anuncios** (comum em infoproduto BR) interrompe 100% da receita -> precisa de BMs/contas reserva + compliance de copy.
6. **Reembolso/chargeback/fraude PIX**: modelar taxa de reembolso de **5–10%** sobre a margem.
7. **Qualidade do ebook 100% LLM**: baixa qualidade aumenta reembolso e mata LTV/reputacao -> revisao editorial minima obrigatoria.
8. **Saturacao de nicho**: um unico ebook satura rapido -> esteira continua de novos produtos.
9. **Capital de giro insuficiente**: fase de aprendizado com ROAS < 1.
10. **Premissa da tarifa Asaas**: se for percentual ou cair em boleto/cartao, remodelar custo de transacao.

## 9. Veredito

A meta de **R$1.000/dia de faturamento bruto e atingivel** com:
- AOV efetivo **~R$72** (ancora R$47 + bump R$27 + upsell R$97),
- conversao de LP **2–3%**,
- CPV **<= R$1,00** e ROAS operacional **~2,0x**,
- rampa de **4 semanas** e reserva de **R$3–5k**.

Lucro liquido esperado nos cenarios bons: **~R$280–530/dia**. Fora dessa janela (CPV alto, conversao < 2%, sem bump/upsell), o modelo e deficitario.
