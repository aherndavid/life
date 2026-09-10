import http.server
import socketserver
import json
import csv
import os
import datetime
import urllib.parse

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

PORT = 8001
CSV_FILE = 'life_entries.csv'
FIELDNAMES = ['date', 'time', 'category', 'details', 'type', 'amount', 'trans_type', 'due_date', 'paid', 'extra']
SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']

def get_calendar_events(days):
    creds = None
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        with open('token.json', 'w') as token:
            token.write(creds.to_json())

    service = build('calendar', 'v3', credentials=creds)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    time_max = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=days)).isoformat()
    
    events_result = service.events().list(
        calendarId='primary', timeMin=now, timeMax=time_max,
        maxResults=100, singleEvents=True,
        orderBy='startTime').execute()
        
    return events_result.get('items', [])

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/Life':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            
            try:
                raw_entry = json.loads(post_data.decode('utf-8'))
                
                entry = {field: raw_entry.get(field, '') for field in FIELDNAMES}
                if not entry.get('type'):
                    entry['type'] = 'diary'
                if not entry.get('paid'):
                    entry['paid'] = 'false'
                
                file_exists = os.path.isfile(CSV_FILE)
                
                with open(CSV_FILE, 'a', newline='') as csvfile:
                    writer = csv.DictWriter(csvfile, fieldnames=FIELDNAMES)
                    if not file_exists:
                        writer.writeheader()
                    writer.writerow(entry)
                    
                print(f"Saved new row to {CSV_FILE}:", entry)
                
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
                
            except Exception as e:
                print("Error processing data:", e)
                self.send_error(500, "Internal Server Error")
        else:
            self.send_error(404, "Endpoint not found")

    def do_PUT(self):
        if self.path.startswith('/Life/'):
            try:
                index = int(self.path.split('/')[-1])
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                raw_entry = json.loads(post_data.decode('utf-8'))
                
                if os.path.isfile(CSV_FILE):
                    with open(CSV_FILE, 'r') as csvfile:
                        reader = csv.DictReader(csvfile, fieldnames=FIELDNAMES)
                        rows = []
                        first_row = True
                        for row in reader:
                            if first_row and row.get('date') == 'date':
                                first_row = False
                                continue
                            first_row = False
                            rows.append(row)
                            
                    if 0 <= index < len(rows):
                        for field in FIELDNAMES:
                            if field in raw_entry:
                                rows[index][field] = str(raw_entry[field])
                                
                        with open(CSV_FILE, 'w', newline='') as csvfile:
                            writer = csv.DictWriter(csvfile, fieldnames=FIELDNAMES)
                            writer.writeheader()
                            writer.writerows(rows)
                            
                        print(f"Updated row {index}:", rows[index])
                        
                        self.send_response(200)
                        self.send_header('Content-type', 'application/json')
                        self.end_headers()
                        self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
                        return
                
                self.send_error(404, "Entry not found")
            except Exception as e:
                print("Error updating data:", e)
                self.send_error(500, "Internal Server Error")
        else:
            self.send_error(404, "Endpoint not found")

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        
        if parsed_path.path == '/Life':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            
            entries = []
            if os.path.isfile(CSV_FILE):
                with open(CSV_FILE, 'r') as csvfile:
                    reader = csv.DictReader(csvfile, fieldnames=FIELDNAMES)
                    first_row = True
                    for row in reader:
                        if first_row and row.get('date') == 'date':
                            first_row = False
                            continue
                        first_row = False
                        
                        for field in FIELDNAMES:
                            if field not in row or row[field] is None:
                                row[field] = ''
                        
                        if not row.get('type'):
                            if row.get('amount') and float(row.get('amount') or 0) > 0:
                                row['type'] = 'finance'
                            else:
                                row['type'] = 'diary'
                                
                        entries.append(row)
            
            self.wfile.write(json.dumps(entries).encode('utf-8'))
            
        elif parsed_path.path == '/Calendar':
            query = urllib.parse.parse_qs(parsed_path.query)
            days = int(query.get('days', [7])[0])
            
            try:
                events = get_calendar_events(days)
                formatted_events = []
                for event in events:
                    start = event['start'].get('dateTime', event['start'].get('date'))
                    formatted_events.append({
                        'summary': event.get('summary', 'Busy'),
                        'start': start
                    })
                    
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(formatted_events).encode('utf-8'))
                
            except Exception as e:
                print("Calendar API Error:", e)
                self.send_error(500, "Internal Server Error")
        else:
            super().do_GET()

    def do_DELETE(self):
        if self.path.startswith('/Life/'):
            try:
                index = int(self.path.split('/')[-1])
                
                if os.path.isfile(CSV_FILE):
                    with open(CSV_FILE, 'r') as csvfile:
                        reader = csv.DictReader(csvfile, fieldnames=FIELDNAMES)
                        rows = []
                        first_row = True
                        for row in reader:
                            if first_row and row.get('date') == 'date':
                                first_row = False
                                continue
                            first_row = False
                            rows.append(row)
                        
                    if 0 <= index < len(rows):
                        deleted_row = rows.pop(index)
                        
                        with open(CSV_FILE, 'w', newline='') as csvfile:
                            writer = csv.DictWriter(csvfile, fieldnames=FIELDNAMES)
                            writer.writeheader()
                            writer.writerows(rows)
                            
                        print(f"Deleted row {index}:", deleted_row)
                        
                        self.send_response(200)
                        self.send_header('Content-type', 'application/json')
                        self.end_headers()
                        self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
                        return
                
                self.send_error(404, "Entry not found")
            except Exception as e:
                print("Error deleting data:", e)
                self.send_error(500, "Internal Server Error")
        else:
            self.send_error(404, "Endpoint not found")

with socketserver.TCPServer(("", PORT), CustomHandler) as httpd:
    print(f"Server active on http://localhost:{PORT}")
    httpd.serve_forever()