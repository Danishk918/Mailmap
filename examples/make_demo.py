"""Build a demo .mbox with made-up senders, so you can try mailmap without a real inbox."""
import mailbox
import random
import sys
from email.message import EmailMessage
from email.utils import format_datetime
from datetime import datetime, timedelta, timezone

SENDERS = [
    ("Strømmetjeneste", "no-reply@stream.example", ["Velkommen!", "Nye serier denne uken"], True),
    ("Nettbutikk", "ordre@butikk.example", ["Kvittering for ordre 1042", "Black Week starter nå"], True),
    ("Avisa", "nyhetsbrev@avisa.example", ["Morgenbrief", "Kveldens saker"], True),
    ("Treningsapp", "hei@trening.example", ["Bekreft e-postadressen din", "Ukesrapport"], False),
    ("Reiseportal", "deals@reise.example", ["Billige fly til Roma", "Siste sjanse"], True),
    ("Forum", "noreply@forum.example", ["Tilbakestill passord"], None),
    ("Webinar AS", "events@webinar.example", ["Invitasjon: Sky og sikkerhet"], False),
]

def build(path):
    rnd = random.Random(1)
    box = mailbox.mbox(path)
    now = datetime(2026, 10, 13, tzinfo=timezone.utc)
    for name, addr, subjects, one_click in SENDERS:
        for i in range(rnd.randint(2, 40)):
            m = EmailMessage()
            m["From"] = f"{name} <{addr}>"
            m["Subject"] = subjects[i % len(subjects)]
            m["Date"] = format_datetime(now - timedelta(days=rnd.randint(1, 900)))
            dom = addr.split("@")[1]
            if one_click is not None:
                m["List-Unsubscribe"] = f"<https://{dom}/unsubscribe?t=demo>, <mailto:unsub@{dom}>"
                if one_click:
                    m["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
            m.set_content("demo")
            box.add(mailbox.mboxMessage(m))
    box.flush(); box.close()

if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "demo.mbox")
