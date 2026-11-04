import {
  type Entity,
  MEASURE_AGGREGATIONS,
  type MeasureAggregation,
  Permission,
  type SemanticModelDetail,
  SEMANTIC_KEY_PATTERN,
} from '@insightai/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { errorMessage } from '@/lib/errors';
import { datasetsApi } from '../datasets/datasets-api';
import { orgKey, useActiveOrganization, usePermission } from '../organizations/use-organization';
import { semanticApi } from './semantic-api';

type Update = (model: SemanticModelDetail) => void;

/** Draft editing of entities, their dimensions/measures, and relationships. */
export function ModelTab({ model, onChange }: { model: SemanticModelDetail; onChange: Update }) {
  const { t } = useTranslation();
  const canWrite = usePermission(Permission.SEMANTIC_WRITE);
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-8">
      <section className="space-y-3" aria-labelledby="semantic-entities">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h2 id="semantic-entities" className="text-lg font-semibold">
              {t('semantic.entities')}
            </h2>
            <p className="text-muted-foreground text-sm">{t('semantic.entitiesHint')}</p>
          </div>
          {canWrite && !adding && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus />
              {t('semantic.addEntity')}
            </Button>
          )}
        </div>
        {adding && (
          <EntityForm
            modelId={model.id}
            onCancel={() => setAdding(false)}
            onDone={(m) => {
              onChange(m);
              setAdding(false);
            }}
          />
        )}
        {model.entities.length === 0 && !adding ? (
          <p className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
            {t('semantic.noEntities')}
          </p>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {model.entities.map((entity) => (
              <EntityCard key={entity.id} entity={entity} canWrite={canWrite} onChange={onChange} />
            ))}
          </div>
        )}
      </section>

      <Relationships model={model} canWrite={canWrite} onChange={onChange} />
    </div>
  );
}

/** Columns of an entity's dataset (active version), for pickers. */
function useDatasetColumns(datasetId: string) {
  const { organizationId } = useActiveOrganization();
  return useQuery({
    queryKey: orgKey(organizationId, 'dataset', datasetId),
    queryFn: () => datasetsApi.get(datasetId),
    enabled: datasetId !== '',
    select: (d) => d.columns,
  });
}

function EntityForm({
  modelId,
  onCancel,
  onDone,
}: {
  modelId: string;
  onCancel: () => void;
  onDone: Update;
}) {
  const { t } = useTranslation();
  const { organizationId } = useActiveOrganization();
  const datasets = useQuery({
    queryKey: orgKey(organizationId, 'datasets'),
    queryFn: datasetsApi.list,
  });
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [primaryKey, setPrimaryKey] = useState<string[]>([]);
  const columns = useDatasetColumns(datasetId);
  const create = useMutation({
    mutationFn: () => semanticApi.createEntity(modelId, { key, name, datasetId, primaryKey }),
    onSuccess: onDone,
  });
  const keyValid = SEMANTIC_KEY_PATTERN.test(key);

  return (
    <form
      className="bg-card space-y-4 rounded-xl border p-4"
      aria-label={t('semantic.addEntity')}
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <Field label={t('semantic.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label={t('semantic.key')}
          hint={t('semantic.keyHint')}
          error={key && !keyValid ? t('semantic.keyInvalid') : undefined}
        >
          <Input
            className="font-mono"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="order"
          />
        </Field>
        <Field label={t('semantic.dataset')}>
          <NativeSelect
            value={datasetId}
            onChange={(e) => {
              setDatasetId(e.target.value);
              setPrimaryKey([]);
            }}
          >
            <option value="">{t('semantic.choose')}</option>
            {(datasets.data ?? [])
              .filter((d) => d.activeVersion)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </NativeSelect>
        </Field>
      </div>
      {columns.data && (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{t('semantic.primaryKey')}</legend>
          <p className="text-muted-foreground mb-2 text-xs">{t('semantic.primaryKeyHint')}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {columns.data.map((c) => (
              <label key={c.name} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={primaryKey.includes(c.name)}
                  onChange={(e) =>
                    setPrimaryKey(
                      e.target.checked
                        ? [...primaryKey, c.name]
                        : primaryKey.filter((n) => n !== c.name),
                    )
                  }
                />
                <span className="font-mono text-xs">{c.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {create.isError && <Alert variant="destructive">{errorMessage(t, create.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={
            create.isPending || !keyValid || !name.trim() || !datasetId || primaryKey.length === 0
          }
        >
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

function EntityCard({
  entity,
  canWrite,
  onChange,
}: {
  entity: Entity;
  canWrite: boolean;
  onChange: Update;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState<'dimension' | 'measure' | null>(null);
  const remove = useMutation({
    mutationFn: (target: { kind: 'entity' | 'dimension' | 'measure'; id: string }) =>
      target.kind === 'entity'
        ? semanticApi.deleteEntity(target.id)
        : target.kind === 'dimension'
          ? semanticApi.deleteDimension(target.id)
          : semanticApi.deleteMeasure(target.id),
    onSuccess: onChange,
  });

  const memberRow = (
    kind: 'dimension' | 'measure',
    id: string,
    key: string,
    label: string,
    detail: string,
    badge?: string,
  ) => (
    <li key={id} className="flex items-center gap-2 py-1.5 text-sm">
      <span className="min-w-0 flex-1">
        <span className="font-medium">{label}</span>{' '}
        <span className="text-muted-foreground font-mono text-xs">
          {entity.key}.{key}
        </span>
        <span className="text-muted-foreground block truncate font-mono text-xs" title={detail}>
          {detail}
        </span>
      </span>
      {badge && <Badge variant="secondary">{badge}</Badge>}
      {canWrite && (
        <Button
          variant="ghost"
          size="icon"
          className="text-destructive size-7"
          aria-label={t('semantic.deleteMember', { member: `${entity.key}.${key}` })}
          onClick={() => remove.mutate({ kind, id })}
        >
          <Trash2 />
        </Button>
      )}
    </li>
  );

  return (
    <section className="bg-card space-y-3 rounded-xl border p-4" aria-label={entity.name}>
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">{entity.name}</h3>
          <p className="text-muted-foreground text-xs">
            <span className="font-mono">{entity.key}</span> ·{' '}
            {t('semantic.fromDataset', { name: entity.datasetName })} ·{' '}
            {t('semantic.grain', { columns: entity.primaryKey.join(', ') })}
          </p>
        </div>
        {canWrite && (
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive size-8"
            aria-label={t('semantic.deleteEntity', { entity: entity.key })}
            onClick={() => {
              if (window.confirm(t('semantic.deleteEntityConfirm', { entity: entity.name }))) {
                remove.mutate({ kind: 'entity', id: entity.id });
              }
            }}
          >
            <Trash2 />
          </Button>
        )}
      </header>
      {remove.isError && <Alert variant="destructive">{errorMessage(t, remove.error)}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="text-muted-foreground text-xs font-medium uppercase">
            {t('semantic.dimensions')}
          </h4>
          <ul className="divide-y">
            {entity.dimensions.map((d) =>
              memberRow(
                'dimension',
                d.id,
                d.key,
                d.name,
                d.expr,
                d.type === 'TIME' ? t('semantic.time') : undefined,
              ),
            )}
          </ul>
          {entity.dimensions.length === 0 && (
            <p className="text-muted-foreground py-1 text-xs">—</p>
          )}
        </div>
        <div>
          <h4 className="text-muted-foreground text-xs font-medium uppercase">
            {t('semantic.measures')}
          </h4>
          <ul className="divide-y">
            {entity.measures.map((m) =>
              memberRow('measure', m.id, m.key, m.name, `${m.agg}(${m.expr ?? '*'})`),
            )}
          </ul>
          {entity.measures.length === 0 && <p className="text-muted-foreground py-1 text-xs">—</p>}
        </div>
      </div>

      {canWrite &&
        (adding ? (
          <MemberForm
            entity={entity}
            kind={adding}
            onCancel={() => setAdding(null)}
            onDone={(m) => {
              onChange(m);
              setAdding(null);
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setAdding('dimension')}>
              <Plus />
              {t('semantic.addDimension')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAdding('measure')}>
              <Plus />
              {t('semantic.addMeasure')}
            </Button>
          </div>
        ))}
    </section>
  );
}

function MemberForm({
  entity,
  kind,
  onCancel,
  onDone,
}: {
  entity: Entity;
  kind: 'dimension' | 'measure';
  onCancel: () => void;
  onDone: Update;
}) {
  const { t } = useTranslation();
  const columns = useDatasetColumns(entity.datasetId);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<'CATEGORICAL' | 'TIME'>('CATEGORICAL');
  const [agg, setAgg] = useState<MeasureAggregation>('sum');
  const [expr, setExpr] = useState('');
  const save = useMutation({
    mutationFn: () =>
      kind === 'dimension'
        ? semanticApi.createDimension(entity.id, { key, name, type, expr })
        : semanticApi.createMeasure(entity.id, {
            key,
            name,
            agg,
            expr: expr.trim() === '' ? null : expr,
          }),
    onSuccess: onDone,
  });
  const keyValid = SEMANTIC_KEY_PATTERN.test(key);
  const exprRequired = kind === 'dimension' || agg !== 'count';

  return (
    <form
      className="bg-muted/30 space-y-3 rounded-lg border p-3"
      aria-label={kind === 'dimension' ? t('semantic.addDimension') : t('semantic.addMeasure')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('semantic.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label={t('semantic.key')}
          error={key && !keyValid ? t('semantic.keyInvalid') : undefined}
        >
          <Input className="font-mono" value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        {kind === 'dimension' ? (
          <Field label={t('semantic.dimensionType')}>
            <NativeSelect value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="CATEGORICAL">{t('semantic.categorical')}</option>
              <option value="TIME">{t('semantic.time')}</option>
            </NativeSelect>
          </Field>
        ) : (
          <Field label={t('semantic.aggregation')}>
            <NativeSelect
              value={agg}
              onChange={(e) => setAgg(e.target.value as MeasureAggregation)}
            >
              {MEASURE_AGGREGATIONS.map((a) => (
                <option key={a} value={a}>
                  {t(`semantic.agg.${a}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field
          label={t('semantic.expression')}
          hint={exprRequired ? t('semantic.expressionHint') : t('semantic.countHint')}
        >
          <Input
            className="font-mono"
            list={`columns-${entity.id}`}
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
          />
        </Field>
        <datalist id={`columns-${entity.id}`}>
          {(columns.data ?? []).map((c) => (
            <option key={c.name} value={c.name} />
          ))}
        </datalist>
      </div>
      {save.isError && <Alert variant="destructive">{errorMessage(t, save.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={save.isPending || !keyValid || !name.trim() || (exprRequired && !expr.trim())}
        >
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

function Relationships({
  model,
  canWrite,
  onChange,
}: {
  model: SemanticModelDetail;
  canWrite: boolean;
  onChange: Update;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const byId = new Map(model.entities.map((e) => [e.id, e]));
  const change = useMutation({
    mutationFn: (action: { id: string; preferred?: boolean; delete?: boolean }) =>
      action.delete
        ? semanticApi.deleteRelationship(action.id)
        : semanticApi.updateRelationship(action.id, { preferred: action.preferred }),
    onSuccess: onChange,
  });

  return (
    <section className="space-y-3" aria-labelledby="semantic-relationships">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 id="semantic-relationships" className="text-lg font-semibold">
            {t('semantic.relationships')}
          </h2>
          <p className="text-muted-foreground text-sm">{t('semantic.relationshipsHint')}</p>
        </div>
        {canWrite && !adding && model.entities.length >= 2 && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus />
            {t('semantic.addRelationship')}
          </Button>
        )}
      </div>
      {adding && (
        <RelationshipForm
          model={model}
          onCancel={() => setAdding(false)}
          onDone={(m) => {
            onChange(m);
            setAdding(false);
          }}
        />
      )}
      {change.isError && <Alert variant="destructive">{errorMessage(t, change.error)}</Alert>}
      {model.relationships.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('semantic.noRelationships')}</p>
      ) : (
        <ul className="space-y-2">
          {model.relationships.map((r) => (
            <li
              key={r.id}
              className="bg-card flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm"
            >
              <span className="font-medium">{byId.get(r.fromEntityId)?.name}</span>
              <ArrowRight className="text-muted-foreground size-4" aria-hidden />
              <span className="font-medium">{byId.get(r.toEntityId)?.name}</span>
              <span className="text-muted-foreground font-mono text-xs">
                {r.joinColumns.map((p) => `${p.from} = ${p.to}`).join(', ')}
              </span>
              <Badge variant="secondary">{t(`semantic.cardinality.${r.cardinality}`)}</Badge>
              <label className="ml-auto flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={r.preferred}
                  disabled={!canWrite || change.isPending}
                  onChange={(e) => change.mutate({ id: r.id, preferred: e.target.checked })}
                />
                {t('semantic.preferred')}
              </label>
              {canWrite && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive size-7"
                  aria-label={t('semantic.deleteRelationship')}
                  onClick={() => change.mutate({ id: r.id, delete: true })}
                >
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RelationshipForm({
  model,
  onCancel,
  onDone,
}: {
  model: SemanticModelDetail;
  onCancel: () => void;
  onDone: Update;
}) {
  const { t } = useTranslation();
  const [fromId, setFromId] = useState(model.entities[0]?.id ?? '');
  const [toId, setToId] = useState(model.entities[1]?.id ?? '');
  const [fromColumn, setFromColumn] = useState('');
  const [toColumn, setToColumn] = useState('');
  const [cardinality, setCardinality] = useState<'MANY_TO_ONE' | 'ONE_TO_ONE'>('MANY_TO_ONE');
  const from = model.entities.find((e) => e.id === fromId);
  const to = model.entities.find((e) => e.id === toId);
  const fromColumns = useDatasetColumns(from?.datasetId ?? '');
  const toColumns = useDatasetColumns(to?.datasetId ?? '');
  const save = useMutation({
    mutationFn: () =>
      semanticApi.createRelationship(model.id, {
        fromEntityId: fromId,
        toEntityId: toId,
        joinColumns: [{ from: fromColumn, to: toColumn }],
        cardinality,
      }),
    onSuccess: onDone,
  });

  const entityOptions = model.entities.map((e) => (
    <option key={e.id} value={e.id}>
      {e.name}
    </option>
  ));
  return (
    <form
      className="bg-card space-y-4 rounded-xl border p-4"
      aria-label={t('semantic.addRelationship')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Field label={t('semantic.fromEntity')} hint={t('semantic.fromEntityHint')}>
          <NativeSelect
            value={fromId}
            onChange={(e) => {
              setFromId(e.target.value);
              setFromColumn('');
            }}
          >
            {entityOptions}
          </NativeSelect>
        </Field>
        <Field label={t('semantic.fromColumn')}>
          <NativeSelect value={fromColumn} onChange={(e) => setFromColumn(e.target.value)}>
            <option value="">{t('semantic.choose')}</option>
            {(fromColumns.data ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('semantic.toEntity')} hint={t('semantic.toEntityHint')}>
          <NativeSelect
            value={toId}
            onChange={(e) => {
              setToId(e.target.value);
              setToColumn('');
            }}
          >
            {entityOptions}
          </NativeSelect>
        </Field>
        <Field label={t('semantic.toColumn')}>
          <NativeSelect value={toColumn} onChange={(e) => setToColumn(e.target.value)}>
            <option value="">{t('semantic.choose')}</option>
            {(toColumns.data ?? []).map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('semantic.cardinalityLabel')}>
          <NativeSelect
            value={cardinality}
            onChange={(e) => setCardinality(e.target.value as typeof cardinality)}
          >
            <option value="MANY_TO_ONE">{t('semantic.cardinality.MANY_TO_ONE')}</option>
            <option value="ONE_TO_ONE">{t('semantic.cardinality.ONE_TO_ONE')}</option>
          </NativeSelect>
        </Field>
      </div>
      {save.isError && <Alert variant="destructive">{errorMessage(t, save.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={save.isPending || fromId === toId || !fromColumn || !toColumn}
        >
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
