import test from 'node:test';
import assert from 'node:assert/strict';
import {finishedGoodsView, inspectionChoices, canManageFinishedGoods, batchResolutions} from '../../web/src/mesFinishedGoodsView';

test('reconstructs independent batch states from server datasets', () => {
  const rows = finishedGoodsView({
    finishedGoodsBatches: [
      {id:'a',batchNumber:'A',workOrderId:'w',reportId:'r',quantity:4,status:'released'},
      {id:'b',batchNumber:'B',workOrderId:'w',reportId:'r',quantity:2,status:'pending_inspection'},
      {id:'c',batchNumber:'C',workOrderId:'w',reportId:'r',quantity:3,status:'received'}
    ],
    finishedGoodsQualityDispositions: [{batchId:'a',passedQuantity:4,failedQuantity:0,disposition:'release'}],
    finishedGoodsInventory: [{batchId:'c',quantityOnHand:3}]
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].batchId, 'a');
  assert.equal(rows[0].passedQuantity, 4);
  assert.equal(rows[1].passedQuantity, undefined);
  assert.equal(rows[2].receivedQuantity, 3);
  assert.deepEqual(finishedGoodsView({}), []);
});

test('inspection choices are scoped to the selected batch report', () => {
  const checks = [{id:'one',workOrderId:'w',reportId:'r1'}, {id:'two',workOrderId:'w',reportId:'r2'}, {id:'other',workOrderId:'x',reportId:'r1'}];
  assert.deepEqual(inspectionChoices(checks, {workOrderId:'w',reportId:'r1'}).map(row => row.id), ['one']);
  assert.deepEqual(inspectionChoices(checks, {workOrderId:'w',reportId:'r2'}).map(row => row.id), ['two']);
});

test('only administrators can manage finished goods', () => {
  assert.equal(canManageFinishedGoods('admin'), true);
  assert.equal(canManageFinishedGoods('operator'), false);
  assert.equal(canManageFinishedGoods('readonly'), false);
});

test('resolution history is scoped to the selected batch and ordered newest first', () => {
  const rows = [
    {id:'old',batchId:'a',disposition:'rework',quantity:5,reason:'repair',createdAt:'2026-01-01'},
    {id:'other',batchId:'b',disposition:'scrap',quantity:2,reason:'other batch',createdAt:'2026-01-03'},
    {id:'new',batchId:'a',disposition:'scrap',quantity:5,reason:'damaged',createdAt:'2026-01-02'}
  ];
  assert.deepEqual(batchResolutions(rows, 'a').map(row => row.id), ['new', 'old']);
  assert.deepEqual(batchResolutions(rows, 'missing'), []);
  assert.deepEqual(rows.map(row => row.id), ['old', 'other', 'new']);
});

test('a reworked pending batch does not show an old quarantine as current inspection', () => {
  const rows = finishedGoodsView({
    finishedGoodsBatches: [{id:'b',batchNumber:'B',workOrderId:'w',reportId:'r',quantity:5,status:'pending_inspection'}],
    finishedGoodsQualityDispositions: [{batchId:'b',passedQuantity:2,failedQuantity:3,disposition:'quarantine'}]
  });
  assert.equal(rows[0].passedQuantity, undefined);
  assert.equal(rows[0].failedQuantity, undefined);
  assert.equal(rows[0].disposition, undefined);
});