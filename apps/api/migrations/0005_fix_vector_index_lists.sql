-- 修复 IVFFlat 索引参数。
--
-- 背景：0004 建索引时硬编码 lists = 10。空表阶段看不出问题，但 lists 必须随
-- 数据量增长（pgvector 建议 lists ≈ rows / 1000）。在 14 万 chunks 规模下，
-- lists=10 会让单次向量查询退化成接近全表扫描（实测 2408ms），
-- 直接吃掉 /search 的语义检索预算，导致 similar 恒为空。
--
-- 这里按实际行数重建索引，并把 maintenance_work_mem 临时调高
-- （默认 64MB 不足以对 14 万 × 1536 维向量建索引）。

SET maintenance_work_mem = '256MB';

DO $$
DECLARE
  n bigint;
  l int;
BEGIN
  SELECT count(*) INTO n FROM chunks WHERE embedding IS NOT NULL;

  IF n = 0 THEN
    RAISE NOTICE 'chunks 表暂无向量，跳过索引重建（首次同步后请重跑本迁移）';
    RETURN;
  END IF;

  l := GREATEST(10, (n / 1000)::int);
  RAISE NOTICE '重建向量索引：rows=%, lists=%', n, l;

  EXECUTE 'DROP INDEX IF EXISTS chunks_embedding_ivfflat';
  EXECUTE format(
    'CREATE INDEX chunks_embedding_ivfflat ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = %s)',
    l
  );
END
$$;

-- 查询时扫描的 list 数；默认 1 召回偏低，10 在 14 万行下仍能保持毫秒级。
-- 如需更高召回可上调（代价是查询变慢）。
ALTER DATABASE notehub SET ivfflat.probes = 10;
