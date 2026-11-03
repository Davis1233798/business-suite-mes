type Row = Record<string, any>;

export function canManageFinishedGoods(role: string) { return role === 'admin'; }

export function batchResolutions(rows: Row[], batchId: string) {
  return rows.filter(row => row.batchId === batchId)
    .sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id)));
}

export function inspectionChoices(checks: Row[], batch: {workOrderId:string; reportId:string}) {
  return checks.filter(row => row.workOrderId === batch.workOrderId && row.reportId === batch.reportId);
}

export function finishedGoodsView(data: Record<string, Row[]>) {
  const dispositions = data.finishedGoodsQualityDispositions || [];
  const inventory = data.finishedGoodsInventory || [];
  return (data.finishedGoodsBatches || []).map(batch => {
    const candidates = dispositions.filter(row => row.batchId === batch.id);
    const quality = batch.status === 'released' || batch.status === 'received'
      ? candidates.find(row => row.disposition === 'release')
      : batch.status === 'quarantined'
        ? candidates.filter(row => row.disposition === 'quarantine').sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0]
        : undefined;
    const stock = inventory.find(row => row.batchId === batch.id);
    return {
      batchId: String(batch.id), batchNumber: String(batch.batchNumber),
      workOrderId: String(batch.workOrderId), reportId: String(batch.reportId),
      quantity: Number(batch.quantity), status: String(batch.status),
      passedQuantity: quality ? Number(quality.passedQuantity) : undefined,
      failedQuantity: quality ? Number(quality.failedQuantity) : undefined,
      disposition: quality?.disposition as string | undefined,
      receivedQuantity: stock ? Number(stock.quantityOnHand) : undefined
    };
  });
}