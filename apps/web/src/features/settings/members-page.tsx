import { type CreatedInvitation, type Member, Permission, SystemRole } from '@insightai/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/form/field';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, NativeSelect } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorMessage } from '@/lib/errors';
import { useSession } from '../auth/use-session';
import { organizationsApi } from '../organizations/organizations-api';
import {
  orgKey,
  useActiveOrganization,
  useCurrentOrganization,
  usePermission,
} from '../organizations/use-organization';
import { formatDateTime } from '@/lib/format';
import { PageHeader, Section } from './page-header';

const ROLES = Object.values(SystemRole);

export function MembersPage() {
  const { t } = useTranslation();
  const canInvite = usePermission(Permission.INVITATION_MANAGE);
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('settings.members.title')}
        description={t('settings.members.description')}
      />
      <MembersSection />
      {canInvite && <InvitationsSection />}
    </div>
  );
}

function MembersSection() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const { data: current } = useCurrentOrganization();
  const session = useSession();
  const canManage = usePermission(Permission.MEMBER_MANAGE);
  const isOwner = current?.role === SystemRole.OWNER;
  const [notice, setNotice] = useState<string | null>(null);

  const membersKey = orgKey(organizationId, 'members');
  const members = useQuery({ queryKey: membersKey, queryFn: organizationsApi.members });

  const onDone = (message: string) => async () => {
    setNotice(message);
    await queryClient.invalidateQueries({ queryKey: membersKey });
  };
  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: SystemRole }) =>
      organizationsApi.changeRole(id, role),
    onMutate: () => setNotice(null),
    onSuccess: onDone(t('settings.members.roleChanged')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => organizationsApi.removeMember(id),
    onMutate: () => setNotice(null),
    onSuccess: onDone(t('settings.members.removed')),
  });
  const error = changeRole.error ?? remove.error ?? members.error;

  /**
   * Mirrors API rules to avoid offering actions that would be refused: only owners touch owners.
   * Your own row is never editable here (changing your own role or leaving is a separate flow).
   */
  const editable = (member: Member) =>
    canManage &&
    member.user.id !== session.user?.id &&
    (isOwner || member.role !== SystemRole.OWNER);

  return (
    <Section title={t('settings.members.title')}>
      {error && <Alert variant="destructive">{errorMessage(t, error)}</Alert>}
      {notice && <Alert variant="success">{notice}</Alert>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('settings.members.name')}</TableHead>
            <TableHead>{t('settings.members.email')}</TableHead>
            <TableHead>{t('settings.members.role')}</TableHead>
            <TableHead className="hidden md:table-cell">{t('settings.members.joined')}</TableHead>
            {canManage && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.data?.map((member) => {
            const isSelf = member.user.id === session.user?.id;
            return (
              <TableRow key={member.id}>
                <TableCell className="font-medium">
                  {member.user.fullName}
                  {isSelf && <span className="text-muted-foreground"> ({t('common.you')})</span>}
                </TableCell>
                <TableCell className="text-muted-foreground">{member.user.email}</TableCell>
                <TableCell>
                  {editable(member) ? (
                    <NativeSelect
                      aria-label={`${t('settings.members.role')}: ${member.user.fullName}`}
                      className="h-8 w-40"
                      value={member.role}
                      disabled={changeRole.isPending}
                      onChange={(e) =>
                        changeRole.mutate({ id: member.id, role: e.target.value as SystemRole })
                      }
                    >
                      {ROLES.filter((role) => isOwner || role !== SystemRole.OWNER).map((role) => (
                        <option key={role} value={role}>
                          {t(`roles.${role}`)}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : (
                    <Badge variant="secondary">{t(`roles.${member.role}`)}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground hidden md:table-cell">
                  {formatDateTime(member.joinedAt, i18n.language)}
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    {editable(member) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              t('settings.members.removeConfirm', { name: member.user.fullName }),
                            )
                          ) {
                            remove.mutate(member.id);
                          }
                        }}
                      >
                        {t('common.remove')}
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Section>
  );
}

const EXPIRY_OPTIONS = [24, 72, 168] as const;

function InvitationsSection() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganization();
  const { data: current } = useCurrentOrganization();
  const [role, setRole] = useState<SystemRole>(SystemRole.VIEWER);
  const [expiresInHours, setExpiresInHours] = useState<number>(72);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);

  const invitationsKey = orgKey(organizationId, 'invitations');
  const invitations = useQuery({ queryKey: invitationsKey, queryFn: organizationsApi.invitations });

  const create = useMutation({
    mutationFn: () => organizationsApi.createInvitation({ role, expiresInHours }),
    onSuccess: async (invitation) => {
      setCreated(invitation);
      await queryClient.invalidateQueries({ queryKey: invitationsKey });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => organizationsApi.revokeInvitation(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationsKey }),
  });

  const roles = ROLES.filter((r) => current?.role === SystemRole.OWNER || r !== SystemRole.OWNER);

  return (
    <Section
      title={t('settings.invitations.title')}
      description={t('settings.invitations.description')}
    >
      <form
        className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          setCreated(null);
          create.mutate();
        }}
      >
        <Field label={t('settings.invitations.role')}>
          <NativeSelect value={role} onChange={(e) => setRole(e.target.value as SystemRole)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {t(`roles.${r}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={t('settings.invitations.expiresIn')}>
          <NativeSelect
            value={expiresInHours}
            onChange={(e) => setExpiresInHours(Number(e.target.value))}
          >
            {EXPIRY_OPTIONS.map((hours) => (
              <option key={hours} value={hours}>
                {hours < 48
                  ? t('settings.invitations.hours', { count: hours })
                  : t('settings.invitations.days', { count: hours / 24 })}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? t('settings.invitations.creating') : t('settings.invitations.create')}
        </Button>
      </form>

      {create.isError && <Alert variant="destructive">{errorMessage(t, create.error)}</Alert>}
      {created && <CreatedLink token={created.token} />}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('settings.invitations.active')}</h3>
        {invitations.data?.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('settings.invitations.none')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('settings.invitations.role')}</TableHead>
                <TableHead>{t('settings.invitations.createdBy')}</TableHead>
                <TableHead>{t('settings.invitations.expiresAt')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.data?.map((invitation) => (
                <TableRow key={invitation.id}>
                  <TableCell>
                    <Badge variant="secondary">{t(`roles.${invitation.role}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {invitation.createdBy?.fullName ?? t('settings.audit.formerMember')}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(invitation.expiresAt, i18n.language)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(invitation.id)}
                    >
                      {t('settings.invitations.revoke')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Section>
  );
}

function CreatedLink({ token }: { token: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/invite/${token}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context): the user can still select the text.
    }
  };

  return (
    <Alert variant="success" className="grid gap-2">
      <span>{t('settings.invitations.created')}</span>
      <div className="flex gap-2">
        <Input
          readOnly
          value={link}
          onFocus={(e) => e.target.select()}
          aria-label="Invitation link"
        />
        <Button type="button" variant="outline" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
    </Alert>
  );
}
