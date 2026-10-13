"""Monitoramento: o que mudou entre duas checagens e os avisos (e-mail, webhook).

Política: avisa quando uma URL MUDA de estado (passou a falhar ou voltou ao
normal), e não a cada ciclo; senão um link quebrado vira um e-mail a cada 5
minutos. `repetir_problemas=True` avisa em todo ciclo que ainda tiver problema.
"""

from __future__ import annotations

import json
import smtplib
import ssl
from dataclasses import asdict, dataclass, field
from datetime import datetime
from email.message import EmailMessage
from urllib.parse import urlsplit

import httpx

from . import NOME, VERSAO
from .classificar import eh_problema
from .links import normalizar
from .verificador import Resultado


@dataclass
class ConfigEmail:
    ativo: bool = False
    servidor: str = ""
    porta: int = 587
    seguranca: str = "starttls"  # "starttls", "ssl" ou "nenhuma"
    usuario: str = ""
    senha: str = ""  # em memória: texto puro; em disco: segredos.proteger()
    remetente: str = ""
    destinatarios: str = ""  # separados por vírgula ou ponto e vírgula

    def lista_destinos(self) -> list[str]:
        return [d.strip() for d in self.destinatarios.replace(";", ",").split(",") if d.strip()]


@dataclass
class ConfigAvisos:
    notificacao: bool = True
    webhook: str = ""
    repetir_problemas: bool = False
    avisar_recuperacao: bool = True
    email: ConfigEmail = field(default_factory=ConfigEmail)

    def como_dict(self, proteger=None) -> dict:
        d = asdict(self)
        if proteger:
            d["email"]["senha"] = proteger(self.email.senha)
        return d

    @classmethod
    def de_dict(cls, d: dict, revelar=None) -> "ConfigAvisos":
        d = dict(d or {})
        email = dict(d.pop("email", {}) or {})
        if revelar and email.get("senha"):
            email["senha"] = revelar(email["senha"])
        campos_email = ConfigEmail.__dataclass_fields__
        campos = cls.__dataclass_fields__
        return cls(**{k: v for k, v in d.items() if k in campos and k != "email"},
                   email=ConfigEmail(**{k: v for k, v in email.items() if k in campos_email}))


@dataclass
class Mudancas:
    novos_problemas: list[Resultado]
    recuperados: list[Resultado]
    ainda_com_problema: list[Resultado]
    total: int

    def vazio(self, repetir_problemas: bool = False, avisar_recuperacao: bool = True) -> bool:
        return not (self.novos_problemas or (avisar_recuperacao and self.recuperados)
                    or (repetir_problemas and self.ainda_com_problema))


def comparar(anteriores: list[Resultado] | None, atuais: list[Resultado]) -> Mudancas:
    """Na primeira checagem (sem anteriores) todo problema conta como novo."""
    antes = {normalizar(r.url): eh_problema(r.categoria) for r in (anteriores or [])}
    novos, recuperados, ainda = [], [], []
    for r in atuais:
        k = normalizar(r.url)
        agora = eh_problema(r.categoria)
        tinha = antes.get(k)
        if agora and not tinha:
            novos.append(r)
        elif agora:
            ainda.append(r)
        elif tinha:
            recuperados.append(r)
    return Mudancas(novos, recuperados, ainda, len(atuais))


def _linha(r: Resultado) -> str:
    status = r.status if r.status is not None else "---"
    extra = f" ({r.erro})" if r.erro else ""
    origem = f"\n      encontrado em {r.encontrado_em}" if r.encontrado_em else ""
    return f"  [{status}] {r.url}{extra}{origem}"


def montar_texto(m: Mudancas, alvo: str, repetir_problemas: bool = False) -> tuple[str, str]:
    """(assunto, corpo) em texto puro."""
    problemas = len(m.novos_problemas) + len(m.ainda_com_problema)
    if m.novos_problemas:
        assunto = f"[{NOME}] {len(m.novos_problemas)} link(s) com problema em {alvo}"
    elif m.recuperados and not problemas:
        assunto = f"[{NOME}] Tudo OK de novo em {alvo}"
    else:
        assunto = f"[{NOME}] {problemas} link(s) com problema em {alvo}"
    partes = [f"Checagem de {alvo} em {datetime.now():%d/%m/%Y %H:%M}: {m.total} URLs, {problemas} com problema."]
    if m.novos_problemas:
        partes.append("\nPassaram a falhar:\n" + "\n".join(_linha(r) for r in m.novos_problemas))
    if m.recuperados:
        partes.append("\nVoltaram ao normal:\n" + "\n".join(_linha(r) for r in m.recuperados))
    if repetir_problemas and m.ainda_com_problema:
        partes.append("\nContinuam com problema:\n" + "\n".join(_linha(r) for r in m.ainda_com_problema))
    partes.append(f"\n— {NOME} {VERSAO}")
    return assunto, "\n".join(partes)


def enviar_email(cfg: ConfigEmail, assunto: str, corpo: str, timeout: float = 20) -> None:
    destinos = cfg.lista_destinos()
    if not cfg.servidor or not destinos:
        raise ValueError("Informe o servidor SMTP e pelo menos um destinatário.")
    msg = EmailMessage()
    msg["Subject"] = assunto
    msg["From"] = cfg.remetente or cfg.usuario
    msg["To"] = ", ".join(destinos)
    msg.set_content(corpo)
    contexto = ssl.create_default_context()
    if cfg.seguranca == "ssl":
        smtp = smtplib.SMTP_SSL(cfg.servidor, cfg.porta, timeout=timeout, context=contexto)
    else:
        smtp = smtplib.SMTP(cfg.servidor, cfg.porta, timeout=timeout)
    with smtp:
        if cfg.seguranca == "starttls":
            smtp.starttls(context=contexto)
        if cfg.usuario:
            smtp.login(cfg.usuario, cfg.senha)
        smtp.send_message(msg)


def payload_webhook(m: Mudancas, alvo: str, assunto: str, corpo: str) -> dict:
    """JSON que serve direto para Slack/Google Chat ("text"), Discord ("content")
    e Teams (workflow "text"), além dos dados estruturados."""
    def item(r: Resultado) -> dict:
        return {"url": r.url, "status": r.status, "categoria": r.categoria, "erro": r.erro,
                "encontrado_em": r.encontrado_em}
    texto = f"{assunto}\n{corpo}"
    return {
        "text": texto,
        "content": texto[:1990],
        "origem": f"{NOME} {VERSAO}",
        "alvo": alvo,
        "quando": datetime.now().astimezone().isoformat(timespec="seconds"),
        "total": m.total,
        "novos_problemas": [item(r) for r in m.novos_problemas],
        "recuperados": [item(r) for r in m.recuperados],
        "ainda_com_problema": [item(r) for r in m.ainda_com_problema],
    }


def adaptar_ao_destino(url: str, dados: dict) -> dict:
    """Formato que cada serviço aceita.

    Google Chat (chat.googleapis.com) recusa com 400 qualquer campo que não
    seja do recurso Message: vai só {"text"}, com o título em *negrito*.
    Discord quer "content" (até 2000 caracteres), Slack quer "text". Os demais
    (Teams/Power Automate, n8n, Zapier, servidor próprio) recebem o JSON completo.
    """
    host = (urlsplit(url).hostname or "").lower()
    texto = dados.get("text", "")
    if host == "chat.googleapis.com":
        titulo, _, resto = texto.partition("\n")
        return {"text": (f"*{titulo}*\n{resto}" if titulo else resto)[:4000]}
    if host in ("discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"):
        return {"content": texto[:2000]}
    if host == "hooks.slack.com":
        return {"text": texto[:39000]}
    return dados


def enviar_webhook(url: str, dados: dict, timeout: float = 15) -> int:
    dados = adaptar_ao_destino(url, dados)
    r = httpx.post(url, content=json.dumps(dados, ensure_ascii=False).encode("utf-8"),
                   headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": f"{NOME}/{VERSAO}"},
                   timeout=timeout, follow_redirects=True)
    if r.status_code >= 400:
        raise RuntimeError(f"O webhook respondeu {r.status_code}: {r.text[:200]}")
    return r.status_code


def disparar(cfg: ConfigAvisos, m: Mudancas, alvo: str) -> list[str]:
    """Envia e-mail e webhook (a notificação da área de trabalho é da interface).
    Devolve a lista de erros (vazia se tudo foi)."""
    if m.vazio(cfg.repetir_problemas, cfg.avisar_recuperacao):
        return []
    if not cfg.avisar_recuperacao:
        m = Mudancas(m.novos_problemas, [], m.ainda_com_problema, m.total)
    assunto, corpo = montar_texto(m, alvo, cfg.repetir_problemas)
    erros = []
    if cfg.email.ativo:
        try:
            enviar_email(cfg.email, assunto, corpo)
        except Exception as exc:  # noqa: BLE001
            erros.append(f"E-mail: {exc}")
    if cfg.webhook.strip():
        try:
            enviar_webhook(cfg.webhook.strip(), payload_webhook(m, alvo, assunto, corpo))
        except Exception as exc:  # noqa: BLE001
            erros.append(f"Webhook: {exc}")
    return erros
