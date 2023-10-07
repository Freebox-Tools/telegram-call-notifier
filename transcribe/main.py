import whisper
import sys

audio = sys.argv[1] 
"""
Vous avez le choix entre plusieurs modèles.
tiny : ~ 1GB VRAM
base : ~ 1GB VRAM (léger, rapide mais peu contenir de grosses fautes de langue)
small : ~ 2GB VRAM (meilleur compromis)
medium : ~ 5GB VRAM 
large : ~ 10GB VRAM (meilleur modèle, mais plus lent et plus gourmand en mémoire)
"""
model = whisper.load_model("small")
whisper.warnings.filterwarnings("ignore") # Ignorer les warnings
result = model.transcribe(audio)

print(result["text"])