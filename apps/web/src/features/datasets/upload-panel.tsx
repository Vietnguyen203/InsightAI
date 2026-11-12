import { IMPORT_LIMITS, type ImportJob, type ImportOptions } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import { errorMessage, fieldErrors } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { orgKey, useActiveOrganization } from '../organizations/use-organization';
import { Section } from '../settings/page-header';
import { datasetsApi, importErrorText, isInProgress } from './datasets-api';

type Delimiter = NonNullable<ImportOptions['delimiter']>;

export function UploadPanel({ datasetId }: { datasetId: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const [file, setFile] = useState<File | null>(null);
  const [locale, setLocale] = useState<'vi' | 'en'>(i18n.language === 'en' ? 'en' : 'vi');
  const [delimiter, setDelimiter] = useState<Delimiter | ''>('');
  const [hasHeader, setHasHeader] = useState(true);
  const [sheetName, setSheetName] = useState('');
  const [percent, setPercent] = useState(0);
  const [importId, setImportId] = useState<string | null>(null);

  const isExcel = file?.name.toLowerCase().endsWith('.xlsx') ?? false;

  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error('No file selected');
      const options: ImportOptions = {
        hasHeader,
        ...(isExcel ? (sheetName.trim() ? { sheetName: sheetName.trim() } : {}) : { locale }),
        ...(!isExcel && delimiter ? { delimiter } : {}),
      };
      setPercent(0);
      return datasetsApi.upload(datasetId, file, options, ({ loaded, total }) =>
        setPercent(Math.round((loaded / total) * 100)),
      );
    },
    onSuccess: (job) => setImportId(job.id),
  });

  // Poll the job until it finishes, then refresh everything that shows the dataset.
  const job = useQuery({
    queryKey: orgKey(organizationId, 'import', importId),
    queryFn: () => datasetsApi.importJob(importId!),
    enabled: importId !== null,
    refetchInterval: (query) =>
      isInProgress(query.state.data?.status ?? 'PENDING') ? 1500 : false,
  });
  const finished = job.data && !isInProgress(job.data.status) ? job.data : null;
  const finishedId = finished?.id;
  useEffect(() => {
    if (!finishedId) return;
    void queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'dataset', datasetId) });
    void queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'datasets') });
  }, [finishedId, queryClient, organizationId, datasetId]);

  const busy = upload.isPending || (importId !== null && !finished);

  return (
    <Section title={t('datasets.upload.title')} description={t('datasets.upload.hint')}>
      <form
        className="grid gap-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setImportId(null);
          upload.mutate();
        }}
      >
        <Field label={t('datasets.upload.file')}>
          <Input
            type="file"
            accept={IMPORT_LIMITS.acceptedExtensions.join(',')}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        {isExcel ? (
          <Field label={t('datasets.upload.sheetName')}>
            <Input value={sheetName} onChange={(e) => setSheetName(e.target.value)} />
          </Field>
        ) : (
          <Field label={t('datasets.upload.locale')}>
            <NativeSelect value={locale} onChange={(e) => setLocale(e.target.value as 'vi' | 'en')}>
              <option value="vi">{t('datasets.upload.localeVi')}</option>
              <option value="en">{t('datasets.upload.localeEn')}</option>
            </NativeSelect>
          </Field>
        )}
        {!isExcel && (
          <Field label={t('datasets.upload.delimiter')}>
            <NativeSelect
              value={delimiter}
              onChange={(e) => setDelimiter(e.target.value as Delimiter | '')}
            >
              <option value="">{t('datasets.upload.auto')}</option>
              <option value=",">,</option>
              <option value=";">;</option>
              <option value={'\t'}>Tab</option>
              <option value="|">|</option>
            </NativeSelect>
          </Field>
        )}
        <label className="flex items-center gap-2 self-end text-sm">
          <input
            type="checkbox"
            checked={hasHeader}
            onChange={(e) => setHasHeader(e.target.checked)}
            className="size-4"
          />
          {t('datasets.upload.hasHeader')}
        </label>
        <div className="md:col-span-2">
          <Button type="submit" disabled={!file || busy}>
            <Upload />
            {t('datasets.upload.submit')}
          </Button>
        </div>
      </form>

      {upload.isPending && (
        <div className="space-y-1" role="status">
          <p className="text-sm">{t('datasets.upload.uploading', { percent })}</p>
          <div className="bg-muted h-2 overflow-hidden rounded-full">
            <div className="bg-primary h-full transition-all" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
      {upload.isError && (
        <Alert variant="destructive">
          {/* A refused file names its import error (EMPTY_FILE, UNSUPPORTED_FORMAT…). */}
          {fieldErrors(upload.error).file
            ? t(`datasets.importErrors.${fieldErrors(upload.error).file}`, {
                defaultValue: errorMessage(t, upload.error),
              })
            : errorMessage(t, upload.error)}
        </Alert>
      )}
      {importId !== null && !finished && (
        <Alert role="status">{t('datasets.upload.processing')}</Alert>
      )}
      {finished && <ImportResult job={finished} language={i18n.language} />}
    </Section>
  );
}

function ImportResult({ job, language }: { job: ImportJob; language: string }) {
  const { t } = useTranslation();
  if (job.status === 'FAILED') {
    return (
      <Alert variant="destructive">
        {t('datasets.upload.failed', { message: importErrorText(t, job.error) })}
      </Alert>
    );
  }
  return (
    <Alert variant="success">
      {t('datasets.upload.done', { rows: formatNumber(job.rowsRead ?? 0, language) })}
      {job.warnings.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs">
          {job.warnings.map((warning) => (
            <li key={warning.code}>
              {t(`datasets.warnings.${warning.code}`, { defaultValue: warning.message })}
              {warning.count !== undefined ? ` (${formatNumber(warning.count, language)})` : ''}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}
