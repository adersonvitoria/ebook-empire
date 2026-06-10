'use client';

// Orders — pedidos com status de pagamento/entrega. Consome GET /orders.
// Gatilho de entrega = pagamento CONFIRMED ou RECEIVED (ver schema/decisao D2),
// refletido pelo status do pedido (PAID/DELIVERED).

import { useQuery } from '@tanstack/react-query';
import {
  api,
  ApiError,
  formatBRL,
  formatDateTime,
  type Order,
  type OrderStatus,
  type PaymentStatus,
} from '@/lib/api';

const ORDER_STATUS_STYLES: Record<OrderStatus, string> = {
  PENDING: 'bg-neutral-700/40 text-neutral-300',
  AWAITING_PAYMENT: 'bg-amber-500/20 text-amber-300',
  PAID: 'bg-emerald-500/20 text-emerald-300',
  DELIVERED: 'bg-brand/20 text-brand-fg',
  REFUNDED: 'bg-orange-500/20 text-orange-300',
  CANCELED: 'bg-neutral-800 text-neutral-500',
  EXPIRED: 'bg-neutral-800 text-neutral-500',
};

const PAYMENT_STATUS_STYLES: Record<PaymentStatus, string> = {
  PENDING: 'text-amber-300',
  CONFIRMED: 'text-emerald-300',
  RECEIVED: 'text-emerald-400',
  OVERDUE: 'text-orange-300',
  REFUNDED: 'text-orange-300',
  FAILED: 'text-red-400',
};

function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${ORDER_STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

export default function OrdersPage() {
  const ordersQuery = useQuery({
    queryKey: ['orders', 'list'],
    queryFn: ({ signal }) => api.listOrders({ limit: 100 }, signal),
    retry: false,
  });

  const orders = ordersQuery.data?.data ?? [];
  const listMissing =
    ordersQuery.error instanceof ApiError && ordersQuery.error.status === 404;

  // Resumo simples no topo: total pago x pendente.
  const totalPagoCents = orders
    .filter((o) => o.status === 'PAID' || o.status === 'DELIVERED')
    .reduce((sum, o) => sum + o.priceCents, 0);

  return (
    <div>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Pedidos</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Status de pagamento e entrega de cada compra.
        </p>
      </header>

      {!ordersQuery.isLoading && !ordersQuery.isError && orders.length > 0 ? (
        <div className="mb-6 inline-block rounded-lg border border-neutral-800 bg-neutral-900/50 px-4 py-3">
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            Faturamento (pago) listado
          </span>
          <span className="ml-3 text-sm font-semibold text-emerald-400">
            {formatBRL(totalPagoCents)}
          </span>
        </div>
      ) : null}

      {ordersQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Carregando pedidos…</p>
      ) : ordersQuery.isError ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 text-sm text-neutral-300">
          {listMissing
            ? 'Rota /orders ainda nao implementada.'
            : 'Nao foi possivel carregar os pedidos. Verifique se a API esta no ar.'}
        </div>
      ) : orders.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          Nenhum pedido ainda.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900/80 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">Pedido</th>
                <th className="px-4 py-3 font-medium">Cliente</th>
                <th className="px-4 py-3 font-medium">Valor</th>
                <th className="px-4 py-3 font-medium">Pedido</th>
                <th className="px-4 py-3 font-medium">Pagamento</th>
                <th className="px-4 py-3 font-medium">Campanha</th>
                <th className="px-4 py-3 font-medium">Pago em</th>
                <th className="px-4 py-3 font-medium">Entregue em</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {orders.map((order: Order) => (
                <tr key={order.id} className="hover:bg-neutral-900/40">
                  <td className="px-4 py-3 font-mono text-xs text-neutral-400">
                    {order.id.slice(0, 10)}…
                  </td>
                  <td className="px-4 py-3 text-neutral-300">
                    {order.customerEmail ?? order.customerId.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 font-medium text-white">
                    {formatBRL(order.priceCents)}
                  </td>
                  <td className="px-4 py-3">
                    <OrderStatusBadge status={order.status} />
                  </td>
                  <td className="px-4 py-3">
                    {order.paymentStatus ? (
                      <span
                        className={`text-xs font-medium ${PAYMENT_STATUS_STYLES[order.paymentStatus]}`}
                      >
                        {order.paymentStatus}
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-neutral-400">
                    {order.utmCampaign ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-neutral-400">
                    {formatDateTime(order.paidAt)}
                  </td>
                  <td className="px-4 py-3 text-neutral-400">
                    {formatDateTime(order.deliveredAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
