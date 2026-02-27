# Pi Server Setup

## 1. Installeer Flask op de Pi

```bash
pip3 install flask
```

## 2. Kopieer de server naar de Pi

```bash
scp -r server/ vonk@100.80.1.96:/home/vonk/project-manager/
```

## 3. Start de server (test)

```bash
ssh vonk@100.80.1.96
python3 /home/vonk/project-manager/server/app.py
# DB wordt aangemaakt op /mnt/nas/shared/project-manager.db
```

## 4. Installeer als systemd service (altijd aan)

```bash
sudo cp /home/vonk/project-manager/server/project-manager.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable project-manager
sudo systemctl start project-manager
sudo systemctl status project-manager
```

## 5. Firewall: port 5000 alleen via Tailscale

```bash
sudo ufw allow in on tailscale0 to any port 5000
sudo ufw reload
```

## 6. Test via Tailscale

```bash
curl http://100.80.1.96:5000/api/health
# → {"ok": true, "db": "/mnt/nas/shared/project-manager.db"}
```

## 7. App instellen op de Macs

Open de Project Manager app → Settings:
- Database mode: **API (Raspberry Pi)**
- URL: `http://100.80.1.96:5000`
- Sla op
