import type { Answer, AskEvent, ConversationSummary } from '@insightai/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, MessageSquarePlus, Send, Sparkles, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import { ApiError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { orgKey, useActiveOrganization } from '../organizations/use-organization';
import { semanticApi } from '../semantic/semantic-api';
import { PageHeader } from '../settings/page-header';
import { askApi } from './ask-api';
import { AnswerView } from './answer-view';

const STAGES = ['understanding', 'planning', 'executing', 'explaining'] as const;
type Stage = (typeof STAGES)[number];

/** The question being answered right now (shown until the saved conversation is reloaded). */
interface PendingTurn {
  question: string;
  stage: Stage | null;
  answer: Answer | null;
  error: string | null;
}

export function AskPage() {
  const { t } = useTranslation();
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const [modelKey, setModelKey] = useState('');
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const status = useQuery({
    queryKey: orgKey(organizationId, 'ai-status'),
    queryFn: askApi.status,
  });
  const models = useQuery({
    queryKey: orgKey(organizationId, 'semantic-models'),
    queryFn: semanticApi.models,
  });
  const conversations = useQuery({
    queryKey: orgKey(organizationId, 'conversations'),
    queryFn: askApi.conversations,
  });
  const conversation = useQuery({
    queryKey: orgKey(organizationId, 'conversation', conversationId),
    queryFn: () => askApi.conversation(conversationId!),
    enabled: conversationId !== undefined,
  });

  const published = (models.data ?? []).filter((m) => m.publishedAt !== null);
  const selectedModel = conversation.data?.model ?? (modelKey || published[0]?.key || '');
  const catalog = useQuery({
    queryKey: orgKey(organizationId, 'catalog', selectedModel),
    queryFn: () => semanticApi.catalog(selectedModel),
    enabled: selectedModel !== '' && conversationId === undefined,
  });

  // Leaving the page (or switching conversation) stops a running answer.
  useEffect(() => () => abort.current?.abort(), [conversationId]);
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [pending?.stage, pending?.answer, conversation.data?.messages.length]);

  const busy = pending !== null && pending.answer === null && pending.error === null;
  const enabled = status.data?.enabled ?? false;
  const noQuota = status.data !== undefined && status.data.remainingToday <= 0;

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy || !selectedModel) return;
    setFailure(null);
    setQuestion('');
    setPending({ question: trimmed, stage: null, answer: null, error: null });
    const controller = new AbortController();
    abort.current = controller;
    let target = conversationId;
    const onEvent = (event: AskEvent) => {
      if (event.type === 'conversation') target = event.conversationId;
      if (event.type === 'stage') setPending((p) => p && { ...p, stage: event.stage });
      if (event.type === 'result') setPending((p) => p && { ...p, answer: event.answer });
      if (event.type === 'error') {
        setPending(
          (p) =>
            p && {
              ...p,
              error: t(`ask.errors.${event.code}`, { defaultValue: t('ask.failed') }),
            },
        );
      }
    };
    try {
      await askApi.ask(
        conversationId
          ? { conversationId, question: trimmed }
          : { model: selectedModel, question: trimmed },
        onEvent,
        controller.signal,
      );
      if (target) {
        await queryClient.fetchQuery({
          queryKey: orgKey(organizationId, 'conversation', target),
          queryFn: () => askApi.conversation(target!),
          staleTime: 0,
        });
      }
      setPending(null);
      if (target && target !== conversationId) void navigate(`/ask/${target}`);
    } catch (error) {
      if (controller.signal.aborted) return;
      setPending(null);
      setQuestion(trimmed);
      setFailure(askErrorMessage(error));
    } finally {
      void queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'conversations') });
      void queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'ai-status') });
    }
  }

  function askErrorMessage(error: unknown): string {
    const code = error instanceof ApiError ? error.problem?.code : undefined;
    if (code === 'AI_UNAVAILABLE') return t('ask.unavailable');
    if (code === 'RATE_LIMITED') return t('ask.quotaReached');
    return errorMessage(t, error);
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(question);
  };
  const remove = async (id: string) => {
    if (!window.confirm(t('ask.deleteConfirm'))) return;
    try {
      await askApi.removeConversation(id);
      queryClient.removeQueries({ queryKey: orgKey(organizationId, 'conversation', id) });
      await queryClient.invalidateQueries({ queryKey: orgKey(organizationId, 'conversations') });
      if (id === conversationId) void navigate('/ask');
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  };

  const messages = conversation.data?.messages ?? [];
  const suggestions = (catalog.data?.metrics ?? [])
    .slice(0, 3)
    .map((m) =>
      m.timeDimension
        ? t('ask.suggestionPeriod', { metric: m.label.toLocaleLowerCase() })
        : t('ask.suggestion', { metric: m.label.toLocaleLowerCase() }),
    )
    .map((s) => s.charAt(0).toLocaleUpperCase() + s.slice(1));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t('ask.title')}
        description={t('ask.description')}
        actions={
          conversationId ? (
            <Button variant="outline" asChild>
              <Link to="/ask">
                <MessageSquarePlus />
                {t('ask.newConversation')}
              </Link>
            </Button>
          ) : undefined
        }
      />
      {status.data && !enabled && <Alert>{t('ask.unavailable')}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <ConversationList
          items={conversations.data ?? []}
          loading={conversations.isPending}
          activeId={conversationId}
          onRemove={(id) => void remove(id)}
        />

        <section className="bg-card flex h-[min(48rem,calc(100dvh-10rem))] min-h-[26rem] min-w-0 flex-col rounded-xl border">
          <div className="flex flex-wrap items-center gap-2 border-b p-3">
            {conversationId ? (
              <>
                <h2 className="min-w-0 flex-1 truncate font-medium">
                  {conversation.data?.title ?? t('common.loading')}
                </h2>
                {conversation.data && <Badge variant="outline">{conversation.data.model}</Badge>}
              </>
            ) : (
              <>
                <label htmlFor="ask-model" className="text-muted-foreground text-sm">
                  {t('ask.model')}
                </label>
                <NativeSelect
                  id="ask-model"
                  className="h-8 w-auto max-w-full"
                  value={selectedModel}
                  disabled={published.length === 0 || busy}
                  onChange={(e) => setModelKey(e.target.value)}
                >
                  {published.map((m) => (
                    <option key={m.id} value={m.key}>
                      {m.name}
                    </option>
                  ))}
                </NativeSelect>
              </>
            )}
            {status.data && (
              <span className="text-muted-foreground ml-auto text-xs">
                {t('ask.remaining', {
                  remaining: status.data.remainingToday,
                  limit: status.data.dailyLimit,
                })}
              </span>
            )}
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto p-4" aria-live="polite">
            {conversation.isError && (
              <Alert variant="destructive">{errorMessage(t, conversation.error)}</Alert>
            )}
            {!conversationId && !pending && (
              <EmptyState
                noModel={models.isSuccess && published.length === 0}
                suggestions={enabled && !noQuota ? suggestions : []}
                onPick={(s) => void ask(s)}
              />
            )}
            {messages.map((m) =>
              m.role === 'USER' ? (
                <UserBubble key={m.id} text={m.content} />
              ) : (
                <AssistantBlock key={m.id}>
                  {m.answer ? (
                    <AnswerView
                      answer={m.answer}
                      disabled={busy || !enabled}
                      onPick={(s) => void ask(s)}
                    />
                  ) : (
                    <p>{m.content}</p>
                  )}
                </AssistantBlock>
              ),
            )}
            {pending && (
              <>
                <UserBubble text={pending.question} />
                <AssistantBlock>
                  {pending.answer ? (
                    <AnswerView answer={pending.answer} disabled onPick={() => undefined} />
                  ) : pending.error ? (
                    <p className="text-destructive">{pending.error}</p>
                  ) : (
                    <StageProgress stage={pending.stage} />
                  )}
                </AssistantBlock>
              </>
            )}
            <div ref={bottom} />
          </div>

          <form onSubmit={onSubmit} className="space-y-2 border-t p-3">
            {failure && <Alert variant="destructive">{failure}</Alert>}
            <div className="flex items-end gap-2">
              <textarea
                aria-label={t('ask.question')}
                className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 max-h-40 min-h-10 w-full flex-1 resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px] disabled:opacity-50"
                rows={1}
                maxLength={1000}
                placeholder={conversationId ? t('ask.followUpPlaceholder') : t('ask.placeholder')}
                value={question}
                disabled={!enabled || noQuota || !selectedModel}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void ask(question);
                  }
                }}
              />
              <Button
                type="submit"
                size="icon"
                aria-label={t('ask.send')}
                disabled={busy || !question.trim() || !enabled || noQuota || !selectedModel}
              >
                {busy ? <Loader2 className="animate-spin" /> : <Send />}
              </Button>
            </div>
            {noQuota && enabled && (
              <p className="text-destructive text-xs">{t('ask.quotaReached')}</p>
            )}
          </form>
        </section>
      </div>
    </div>
  );
}

function ConversationList({
  items,
  loading,
  activeId,
  onRemove,
}: {
  items: ConversationSummary[];
  loading: boolean;
  activeId: string | undefined;
  onRemove: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <aside className="min-w-0 space-y-2" aria-label={t('ask.history')}>
      <h2 className="text-muted-foreground px-1 text-xs font-medium uppercase">
        {t('ask.history')}
      </h2>
      {loading && <p className="text-muted-foreground px-1 text-sm">{t('common.loading')}</p>}
      {!loading && items.length === 0 && (
        <p className="text-muted-foreground px-1 text-sm">{t('ask.noHistory')}</p>
      )}
      <ul className="max-h-60 space-y-1 overflow-y-auto lg:max-h-[32rem]">
        {items.map((c) => (
          <li key={c.id} className="group flex items-center gap-1">
            <Link
              to={`/ask/${c.id}`}
              className={cn(
                'hover:bg-accent min-w-0 flex-1 rounded-md px-2 py-1.5 text-sm',
                c.id === activeId && 'bg-accent font-medium',
              )}
              aria-current={c.id === activeId ? 'page' : undefined}
            >
              <span className="block truncate">{c.title}</span>
              <span className="text-muted-foreground block truncate text-xs">
                {c.model} · {formatDateTime(c.lastMessageAt, i18n.language)}
              </span>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              aria-label={t('ask.deleteConversation', { title: c.title })}
              onClick={() => onRemove(c.id)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function EmptyState({
  noModel,
  suggestions,
  onPick,
}: {
  noModel: boolean;
  suggestions: string[];
  onPick: (s: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <Sparkles className="text-primary size-8" />
      <p className="text-muted-foreground max-w-md text-sm">
        {noModel ? t('ask.noModel') : t('ask.intro')}
      </p>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {suggestions.map((s) => (
            <Button key={s} variant="outline" size="sm" onClick={() => onPick(s)}>
              {s}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2 text-sm whitespace-pre-wrap">
        {text}
      </p>
    </div>
  );
}

function AssistantBlock({ children }: { children: ReactNode }) {
  return <div className="max-w-full min-w-0 text-sm">{children}</div>;
}

function StageProgress({ stage }: { stage: Stage | null }) {
  const { t } = useTranslation();
  const current = stage ? STAGES.indexOf(stage) : -1;
  return (
    <ol className="space-y-1" aria-label={t('ask.progress')}>
      {STAGES.map((s, i) => (
        <li
          key={s}
          className={cn('flex items-center gap-2 text-sm', i > current && 'text-muted-foreground')}
        >
          {i < current ? (
            <Check className="text-success size-4" />
          ) : i === current ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <span className="size-4" />
          )}
          {t(`ask.stages.${s}`)}
        </li>
      ))}
    </ol>
  );
}
