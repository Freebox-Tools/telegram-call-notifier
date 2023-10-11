import whisper
import sys
import signal

def sigquit_handler(signum, frame):
    sys.exit(0)

# Définir le gestionnaire de signal pour SIGQUIT
signal.signal(signal.SIGQUIT, sigquit_handler)

audio = sys.argv[1] 

# Reste de votre code...

model = whisper.load_model("small")
whisper.warnings.filterwarnings("ignore") # Ignorer les warnings
result = model.transcribe(audio)

print(result["text"])
